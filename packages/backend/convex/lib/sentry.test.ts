import { resetEnvCache } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSentryEvent, isSentryConfigured, parseSentryDsn, reportError } from "./sentry";

const DSN = "https://abc123def456@o1.ingest.sentry.io/4507";

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache(serverEnv);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setEnv({ SENTRY_DSN: undefined, SENTRY_ENVIRONMENT: undefined });
  vi.restoreAllMocks();
});

describe("parseSentryDsn", () => {
  it("splits a DSN into an envelope endpoint and its key", () => {
    expect(parseSentryDsn(DSN)).toEqual({
      endpoint: "https://o1.ingest.sentry.io/api/4507/envelope/",
      publicKey: "abc123def456",
      projectId: "4507",
    });
  });

  it("returns undefined for anything unparseable, rather than throwing", () => {
    // A typo in the Convex dashboard must degrade to "no reporting", never to
    // "every request 500s".
    expect(parseSentryDsn("not a url")).toBeUndefined();
    expect(parseSentryDsn("https://o1.ingest.sentry.io/")).toBeUndefined();
    expect(parseSentryDsn("https://o1.ingest.sentry.io/4507")).toBeUndefined();
  });
});

describe("isSentryConfigured", () => {
  it("is false with no DSN and false with a broken one", () => {
    setEnv({ SENTRY_DSN: undefined });
    expect(isSentryConfigured()).toBe(false);
    setEnv({ SENTRY_DSN: "https://o1.ingest.sentry.io/4507" });
    expect(isSentryConfigured()).toBe(false);
  });

  it("is true once a usable DSN is present", () => {
    setEnv({ SENTRY_DSN: DSN });
    expect(isSentryConfigured()).toBe(true);
  });
});

describe("buildSentryEvent", () => {
  it("scrubs the exception message with the shared rules", () => {
    const event = buildSentryEvent({
      scope: "auth.otp",
      error: new Error("failed to email 482913 to corey@example.com"),
    });
    const value = JSON.stringify(event);
    expect(value).not.toContain("482913");
    expect(value).not.toContain("corey@example.com");
  });

  it("scrubs the extra bag, which is where a caller smuggles a token out", () => {
    const event = buildSentryEvent({
      scope: "email.send",
      error: new Error("boom"),
      extra: { sessionToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", note: "a@b.com" },
    });
    const value = JSON.stringify(event);
    expect(value).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(value).not.toContain("a@b.com");
  });

  it("keeps the fields Sentry groups on", () => {
    setEnv({ SENTRY_ENVIRONMENT: "production" });
    const event = buildSentryEvent({ scope: "auth.trigger.onCreate", error: new Error("x") }, 1000);
    expect(event["timestamp"]).toBe(1);
    expect(event["environment"]).toBe("production");
    expect(event["level"]).toBe("error");
    expect(event["event_id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("handles a thrown non-Error", () => {
    const event = buildSentryEvent({ scope: "x", error: "just a string" });
    expect(JSON.stringify(event)).toContain("just a string");
  });
});

describe("reportError", () => {
  it("posts an envelope when a DSN is configured", async () => {
    setEnv({ SENTRY_DSN: DSN });
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));

    const sent = await reportError(
      { scope: "auth.otp", error: new Error("boom") },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: 1000 },
    );

    expect(sent).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://o1.ingest.sentry.io/api/4507/envelope/");
    expect(url).toContain("sentry_key=abc123def456");
    const lines = (init.body as string).split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
  });

  it("is a no-op with no DSN, and says so in the log instead", async () => {
    setEnv({ SENTRY_DSN: undefined });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn();

    expect(
      await reportError(
        { scope: "auth.otp", error: new Error("boom") },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("scrubs the local fallback log too — Convex logs are not a safe place", async () => {
    setEnv({ SENTRY_DSN: undefined });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await reportError({
      scope: "auth.otp",
      error: new Error("code 482913 for corey@example.com"),
      extra: { authToken: "secret-value" },
    });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("482913");
    expect(logged).not.toContain("corey@example.com");
    expect(logged).not.toContain("secret-value");
  });

  it("never throws when the transport does", async () => {
    setEnv({ SENTRY_DSN: DSN });
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await reportError({ scope: "x", error: new Error("boom") }, { fetchImpl })).toBe(false);
  });
});
