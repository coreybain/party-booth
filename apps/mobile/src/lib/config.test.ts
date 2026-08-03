import { describe, expect, it } from "vitest";

import { convexSiteUrlFrom, REQUIRED_MOBILE_VARS, resolveAppConfig } from "./config";

import type { RawMobileEnv } from "./config";

const COMPLETE: RawMobileEnv = {
  EXPO_PUBLIC_SITE_URL: "https://www.partybooth.dev",
  EXPO_PUBLIC_CONVEX_URL: "https://acute-lynx-123.convex.cloud",
  EXPO_PUBLIC_SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2",
  EXPO_PUBLIC_EAS_PROJECT_ID: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};

const EMPTY: RawMobileEnv = {
  EXPO_PUBLIC_SITE_URL: undefined,
  EXPO_PUBLIC_CONVEX_URL: undefined,
  EXPO_PUBLIC_SENTRY_DSN: undefined,
  EXPO_PUBLIC_EAS_PROJECT_ID: undefined,
};

describe("convexSiteUrlFrom", () => {
  it("maps the Convex API host to the HTTP-actions host", () => {
    // Better Auth is mounted on Convex HTTP actions, which are served from
    // *.convex.site — pointing the auth client at *.convex.cloud silently 404s.
    expect(convexSiteUrlFrom("https://acute-lynx-123.convex.cloud")).toBe(
      "https://acute-lynx-123.convex.site",
    );
  });

  it("drops any stray path or trailing slash", () => {
    expect(convexSiteUrlFrom("https://acute-lynx-123.convex.cloud/")).toBe(
      "https://acute-lynx-123.convex.site",
    );
  });

  it("leaves self-hosted or proxied deployments untouched", () => {
    expect(convexSiteUrlFrom("https://convex.internal.example.com")).toBe(
      "https://convex.internal.example.com",
    );
  });

  it("returns the input unchanged when it is not a URL", () => {
    expect(convexSiteUrlFrom("not-a-url")).toBe("not-a-url");
  });
});

describe("resolveAppConfig", () => {
  it("reports every required variable when nothing is set", () => {
    const config = resolveAppConfig(EMPTY);
    expect(config.status).toBe("unconfigured");
    if (config.status !== "unconfigured") throw new Error("unreachable");
    expect(config.missing).toEqual([...REQUIRED_MOBILE_VARS]);
  });

  it("treats a blank string the same as unset", () => {
    const config = resolveAppConfig({ ...COMPLETE, EXPO_PUBLIC_CONVEX_URL: "   " });
    expect(config.status).toBe("unconfigured");
    if (config.status !== "unconfigured") throw new Error("unreachable");
    expect(config.missing).toEqual(["EXPO_PUBLIC_CONVEX_URL"]);
  });

  it("resolves a complete environment, deriving the Convex site URL", () => {
    const config = resolveAppConfig(COMPLETE);
    expect(config.status).toBe("ready");
    if (config.status !== "ready") throw new Error("unreachable");

    expect(config.convexUrl).toBe("https://acute-lynx-123.convex.cloud");
    expect(config.convexSiteUrl).toBe("https://acute-lynx-123.convex.site");
    expect(config.siteUrl).toBe("https://www.partybooth.dev");
    expect(config.scheme).toBe("partybooth");
    expect(config.features).toEqual({ sentry: true, push: true });
  });

  it("prefers an explicit EXPO_PUBLIC_CONVEX_SITE_URL over the derivation", () => {
    // Matches how apps/web reads CONVEX_SITE_URL explicitly. Required for self-hosted
    // or proxied deployments, where `.convex.cloud` → `.convex.site` does not hold.
    const config = resolveAppConfig({
      ...COMPLETE,
      EXPO_PUBLIC_CONVEX_SITE_URL: "https://auth.partybooth.app/",
    });
    expect(config.status).toBe("ready");
    if (config.status !== "ready") throw new Error("unreachable");
    expect(config.convexSiteUrl).toBe("https://auth.partybooth.app");
  });

  it("falls back to the derivation when the explicit variable is blank", () => {
    const config = resolveAppConfig({ ...COMPLETE, EXPO_PUBLIC_CONVEX_SITE_URL: "  " });
    expect(config.status).toBe("ready");
    if (config.status !== "ready") throw new Error("unreachable");
    expect(config.convexSiteUrl).toBe("https://acute-lynx-123.convex.site");
  });

  it("stays ready with the optional providers switched off", () => {
    const config = resolveAppConfig({
      ...COMPLETE,
      EXPO_PUBLIC_SENTRY_DSN: undefined,
      EXPO_PUBLIC_EAS_PROJECT_ID: undefined,
    });
    expect(config.status).toBe("ready");
    if (config.status !== "ready") throw new Error("unreachable");

    // The whole point: a missing optional provider degrades to a no-op rather than
    // taking the app down.
    expect(config.features).toEqual({ sentry: false, push: false });
    expect(config.sentryDsn).toBeUndefined();
    expect(config.easProjectId).toBeUndefined();
  });

  it("normalises a trailing slash off the site URL", () => {
    const config = resolveAppConfig({
      ...COMPLETE,
      EXPO_PUBLIC_SITE_URL: "https://www.partybooth.dev/",
    });
    if (config.status !== "ready") throw new Error("unreachable");
    expect(config.siteUrl).toBe("https://www.partybooth.dev");
  });

  it("accepts an overridden scheme", () => {
    const config = resolveAppConfig(COMPLETE, "partybooth-dev");
    if (config.status !== "ready") throw new Error("unreachable");
    expect(config.scheme).toBe("partybooth-dev");
  });
});
