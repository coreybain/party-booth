import { describe, expect, it } from "vitest";

import {
  isSensitiveKey,
  REDACTED,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  scrubValue,
} from "./sentry-scrub";

describe("scrubUrl", () => {
  it("drops the whole query string, signature and all", () => {
    expect(
      scrubUrl("https://utfs.example/f/9a8b7c?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=600&x=1"),
    ).toBe(`https://utfs.example/f/9a8b7c?${REDACTED}`);
  });

  it("drops the fragment", () => {
    expect(scrubUrl("https://partybooth.example/media#token=abc")).toBe(
      `https://partybooth.example/media?${REDACTED}`,
    );
  });

  it("keeps a clean URL untouched apart from normalisation", () => {
    expect(scrubUrl("https://partybooth.example/dashboard")).toBe(
      "https://partybooth.example/dashboard",
    );
  });

  it("redacts the high-entropy segment after /join", () => {
    expect(scrubUrl("https://partybooth.example/join/8Kd2Lm9QpZ")).toBe(
      `https://partybooth.example/join/${REDACTED}`,
    );
  });

  it("redacts invite and reset token segments too", () => {
    expect(scrubUrl("https://partybooth.example/invite/abc123XYZ/accept")).toBe(
      `https://partybooth.example/invite/${REDACTED}/accept`,
    );
  });

  it("strips embedded credentials", () => {
    expect(scrubUrl("https://admin:hunter2@partybooth.example/admin")).toBe(
      "https://partybooth.example/admin",
    );
  });

  it("leaves a non-URL string alone", () => {
    expect(scrubUrl("not a url")).toBe("not a url");
  });
});

describe("scrubText", () => {
  it("redacts email addresses", () => {
    expect(scrubText("OTP sent to Corey.Baines+beta@example.co.uk")).toBe(
      `OTP sent to ${REDACTED}`,
    );
  });

  it("redacts a standalone six-digit code", () => {
    expect(scrubText("Your PartyBooth code is 482913.")).toBe(
      `Your PartyBooth code is ${REDACTED}.`,
    );
  });

  it("redacts a six-digit join code in quotes", () => {
    expect(scrubText('join code "704118" rejected')).toBe(`join code "${REDACTED}" rejected`);
  });

  it("does not mangle hashed chunk names in stack frames", () => {
    const frame = "at Page (/_next/static/chunks/main-app-482913.js:12:3)";
    expect(scrubText(frame)).toBe(frame);
  });

  it("leaves longer digit runs (ids, timestamps) alone", () => {
    expect(scrubText("byteSize 12345678 at 1785312000000")).toBe(
      "byteSize 12345678 at 1785312000000",
    );
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(scrubText(`session=${jwt}`)).toBe(`session=${REDACTED}`);
  });

  it("redacts bearer credentials but keeps the scheme", () => {
    expect(scrubText("Authorization: Bearer sess_abc123def456ghi789")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it("redacts provider API keys by prefix", () => {
    expect(scrubText("Resend rejected key re_A1b2C3d4E5f6G7h8")).toBe(
      `Resend rejected key ${REDACTED}`,
    );
  });

  it("redacts inline secret assignments", () => {
    expect(scrubText("apiKey=abcdefgh&mode=live")).toBe(`apiKey=${REDACTED}&mode=live`);
    expect(scrubText('client_secret: "shhh"')).toBe(`client_secret: ${REDACTED}`);
  });

  it("redacts join tokens in relative paths (Sentry transaction names)", () => {
    expect(scrubText("/join/Tok3nV4lue")).toBe(`/join/${REDACTED}`);
    expect(scrubText("navigated to /invite/abc-123_x from /")).toBe(
      `navigated to /invite/${REDACTED} from /`,
    );
  });

  it("leaves the literal Next.js route pattern alone", () => {
    expect(scrubText("/join/[token]")).toBe("/join/[token]");
  });

  it("handles a realistic mixed message", () => {
    const input =
      "OTP 482913 for corey@example.com failed at https://partybooth.example/join/Tok3nV4lue?v=2";
    expect(scrubText(input)).toBe(
      `OTP ${REDACTED} for ${REDACTED} failed at https://partybooth.example/join/${REDACTED}?${REDACTED}`,
    );
  });

  it("is idempotent", () => {
    const once = scrubText("code 482913 for a@b.com");
    expect(scrubText(once)).toBe(once);
  });
});

describe("isSensitiveKey", () => {
  it.each([
    "authorization",
    "Cookie",
    "Set-Cookie",
    "sessionToken",
    "session_token",
    "refreshToken",
    "apiKey",
    "API_KEY",
    "client_secret",
    "password",
    "signature",
    "X-Amz-Signature",
    "otp",
    "otpCode",
    "joinCode",
    "invite_code",
    "email",
    "userEmail",
    "phone",
    "code",
    "X-Forwarded-For",
    "ip",
    "dsn",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "statusCode",
    "status_code",
    "errorCode",
    "eventId",
    "mediaType",
    "byteSize",
    "design",
    "method",
    "url",
    "userAgent",
    "storageRegion",
  ])("leaves %s alone", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("scrubValue", () => {
  it("redacts sensitive keys wholesale and scrubs the rest", () => {
    expect(
      scrubValue({
        email: "corey@example.com",
        note: "code 482913",
        byteSize: 1024,
        nested: { authorization: "Bearer abcdefghij", ok: true },
      }),
    ).toEqual({
      email: REDACTED,
      note: `code ${REDACTED}`,
      byteSize: 1024,
      nested: { authorization: REDACTED, ok: true },
    });
  });

  it("walks arrays", () => {
    expect(scrubValue(["a@b.com", { otp: "123456" }])).toEqual([REDACTED, { otp: REDACTED }]);
  });

  it("survives cycles", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;
    expect(scrubValue(node)).toEqual({ name: "root", self: "[circular]" });
  });

  it("truncates beyond the depth limit", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain("[truncated]");
  });

  it("passes non-objects through", () => {
    expect(scrubValue(42)).toBe(42);
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(undefined)).toBeUndefined();
    expect(scrubValue(true)).toBe(true);
  });
});

describe("scrubEvent", () => {
  const event = {
    event_id: "0123456789abcdef",
    timestamp: 1785312000,
    release: "web@0.1.0-482913",
    environment: "production",
    platform: "javascript",
    server_name: "iad1-runtime-07.internal",
    message: "OTP 482913 rejected for corey@example.com",
    transaction: "/join/Tok3nV4lue",
    user: { id: "usr_123", email: "corey@example.com", ip_address: "203.0.113.7" },
    request: {
      url: "https://partybooth.example/join/Tok3nV4lue?code=482913",
      method: "GET",
      headers: { Cookie: "better-auth.session=abc", "User-Agent": "Safari" },
      data: { otp: "482913", email: "corey@example.com", eventId: "evt_1" },
    },
    extra: { signedUrl: "https://utfs.example/f/x?X-Amz-Signature=deadbeef" },
    breadcrumbs: [{ category: "fetch", data: { url: "https://api.example/x?token=abc" } }],
  };

  it("preserves grouping metadata verbatim", () => {
    const scrubbed = scrubEvent(structuredClone(event));
    expect(scrubbed?.["event_id"]).toBe("0123456789abcdef");
    expect(scrubbed?.["timestamp"]).toBe(1785312000);
    expect(scrubbed?.["release"]).toBe("web@0.1.0-482913");
    expect(scrubbed?.["environment"]).toBe("production");
    expect(scrubbed?.["platform"]).toBe("javascript");
  });

  it("drops server_name entirely", () => {
    const scrubbed = scrubEvent(structuredClone(event));
    expect(scrubbed).not.toHaveProperty("server_name");
  });

  it("reduces the user to an opaque id", () => {
    expect(scrubEvent(structuredClone(event))?.user).toEqual({ id: "usr_123" });
  });

  it("omits the user object when there is no id", () => {
    const scrubbed = scrubEvent({ user: { email: "corey@example.com" } });
    expect(scrubbed).not.toHaveProperty("user");
  });

  it("scrubs the message, transaction and request", () => {
    const scrubbed = scrubEvent(structuredClone(event));
    expect(scrubbed?.message).toBe(`OTP ${REDACTED} rejected for ${REDACTED}`);
    expect(scrubbed?.transaction).toBe(`/join/${REDACTED}`);
    expect(scrubbed?.request).toEqual({
      url: `https://partybooth.example/join/${REDACTED}?${REDACTED}`,
      method: "GET",
      headers: { Cookie: REDACTED, "User-Agent": "Safari" },
      data: { otp: REDACTED, email: REDACTED, eventId: "evt_1" },
    });
  });

  it("scrubs signed URLs in extra and breadcrumbs", () => {
    const scrubbed = scrubEvent(structuredClone(event));
    expect(scrubbed?.extra).toEqual({ signedUrl: `https://utfs.example/f/x?${REDACTED}` });
    expect(scrubbed?.breadcrumbs).toEqual([
      { category: "fetch", data: { url: `https://api.example/x?${REDACTED}` } },
    ]);
  });

  it("never mutates the event it was given", () => {
    const original = structuredClone(event);
    scrubEvent(original);
    expect(original).toEqual(event);
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs navigation and fetch URLs", () => {
    expect(
      scrubBreadcrumb({
        category: "navigation",
        data: { from: "/", to: "https://partybooth.example/join/Tok3nV4lue?x=1" },
      }),
    ).toEqual({
      category: "navigation",
      data: { from: "/", to: `https://partybooth.example/join/${REDACTED}?${REDACTED}` },
    });
  });
});
