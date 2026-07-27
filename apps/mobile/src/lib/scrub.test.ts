import { describe, expect, it } from "vitest";

import { REDACTED, scrubBreadcrumb, scrubEvent, scrubText, scrubUrl, scrubValue } from "./scrub";

/**
 * The rules themselves are specified in `apps/web/src/lib/sentry-scrub.test.ts`
 * against the same shared module. What matters here is that the Expo app really
 * is wired to that module — the previous local implementation redacted emails
 * and `/join/<token>` and nothing else, so these are the holes that must stay
 * shut.
 */

describe("scrubText", () => {
  it("redacts email addresses", () => {
    expect(scrubText("failed to sign in corey@example.com")).toBe(`failed to sign in ${REDACTED}`);
  });

  it("redacts invite tokens embedded in paths", () => {
    expect(scrubText("GET /join/u7Kd2Qp9Rx4Tv1Wm8Zb3 failed")).toBe(`GET /join/${REDACTED} failed`);
  });

  it("redacts a session JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJlX2hlcmU";
    expect(scrubText(`Authorization failed for ${jwt}`)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts a Bearer credential", () => {
    expect(scrubText("bearer abcdef0123456789")).toBe(`bearer ${REDACTED}`);
  });

  it("redacts a provider API key", () => {
    expect(scrubText("using re_abcdef0123456789")).toBe(`using ${REDACTED}`);
  });

  it("redacts an inline secret assignment", () => {
    expect(scrubText("token=abc123def")).toBe(`token=${REDACTED}`);
  });

  it("redacts a standalone six-digit OTP / join code", () => {
    expect(scrubText("Your code is 482913.")).toBe(`Your code is ${REDACTED}.`);
  });

  it("leaves innocuous text alone", () => {
    expect(scrubText("upload timed out after 30s")).toBe("upload timed out after 30s");
  });
});

describe("scrubUrl", () => {
  it("drops the whole query string, signature and all", () => {
    const signed =
      "https://uploads.example.com/media/1.jpg?X-Amz-Signature=deadbeef&X-Amz-Expires=900";
    expect(scrubUrl(signed)).toBe(`https://uploads.example.com/media/1.jpg?${REDACTED}`);
  });

  it("strips basic-auth credentials", () => {
    expect(scrubUrl("https://user:secret@partybooth.app/x")).toBe("https://partybooth.app/x");
  });

  it("redacts a token that is in the path rather than the query", () => {
    expect(scrubUrl("https://partybooth.app/join/u7Kd2Qp9Rx4Tv1Wm8Zb3")).toBe(
      `https://partybooth.app/join/${REDACTED}`,
    );
  });

  it("leaves an unparseable value for scrubText to handle", () => {
    // `scrubUrl` is the URL rule on its own; `scrubText` — which is what every
    // event path actually goes through — is what catches the rest.
    expect(scrubUrl("corey@example.com")).toBe("corey@example.com");
    expect(scrubText("corey@example.com")).toBe(REDACTED);
  });
});

describe("scrubValue", () => {
  it("replaces sensitive keys outright, however deep", () => {
    const scrubbed = scrubValue({
      outer: { sessionToken: "abc", authorization: "Bearer x", safe: "keep me" },
    }) as { outer: Record<string, unknown> };
    expect(scrubbed.outer["sessionToken"]).toBe(REDACTED);
    expect(scrubbed.outer["authorization"]).toBe(REDACTED);
    expect(scrubbed.outer["safe"]).toBe("keep me");
  });
});

describe("event-level hooks", () => {
  it("walks extra, tags and breadcrumbs, not just request/user/exception", () => {
    const scrubbed = scrubEvent({
      extra: { note: "code 482913 for corey@example.com" },
      tags: { email: "corey@example.com" },
      breadcrumbs: [{ message: "GET /join/u7Kd2Qp9Rx4Tv1Wm8Zb3" }],
    }) as {
      extra: Record<string, string>;
      tags: Record<string, string>;
      breadcrumbs: { message: string }[];
    };

    expect(scrubbed.extra["note"]).not.toContain("482913");
    expect(scrubbed.extra["note"]).not.toContain("corey@example.com");
    expect(scrubbed.tags["email"]).toBe(REDACTED);
    expect(scrubbed.breadcrumbs[0]?.message).toBe(`GET /join/${REDACTED}`);
  });

  it("reduces the user to an opaque id", () => {
    const scrubbed = scrubEvent({
      user: { id: "user_1", email: "corey@example.com", ip_address: "1.2.3.4" },
    }) as { user: Record<string, unknown> };
    expect(scrubbed.user).toEqual({ id: "user_1" });
  });

  it("scrubs breadcrumb data urls", () => {
    const crumb = scrubBreadcrumb({
      category: "fetch",
      data: { url: "https://partybooth.app/join/u7Kd2Qp9Rx4Tv1Wm8Zb3?token=abc" },
    }) as { data: Record<string, string> };
    expect(crumb.data["url"]).not.toContain("u7Kd2Qp9Rx4Tv1Wm8Zb3");
    expect(crumb.data["url"]).not.toContain("abc");
  });
});
