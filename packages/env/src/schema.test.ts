import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createEnv, envKeys, envVar, type EnvDefinition } from "./create-env";
import { clientVars, mobileVars, serverVars, STORAGE_REGIONS } from "./schema";

const EXAMPLE_PATH = fileURLToPath(new URL("../../../.env.example", import.meta.url));

function keysOf(vars: EnvDefinition): string[] {
  return envKeys(createEnv({ id: "probe", vars, runtimeEnv: {} })) as string[];
}

const allDeclaredKeys = [...keysOf(serverVars), ...keysOf(clientVars), ...keysOf(mobileVars)];

function exampleKeys(): string[] {
  const contents = readFileSync(EXAMPLE_PATH, "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=")[0]!.trim())
    .filter((key) => key.length > 0);
}

/**
 * Variables `.env.example` documents that this package deliberately does **not**
 * validate.
 *
 * `packages/env` validates what a **running process** reads — the web server,
 * the Convex deployment, the app bundle. These three are read by `eas submit`
 * from the operator's shell, via the `$VAR` references in
 * `apps/mobile/eas.json`, and never by anything that runs. Putting them in the
 * schema would make every deployment's startup validation care about
 * credentials it has no use for; leaving them undocumented would leave
 * `eas.json` referencing variables nothing explains, which is what happened
 * before Sprint 4's integration pass.
 *
 * So they are documented and exempted, and the two tests below keep the
 * exemption honest in both directions.
 */
const BUILD_TOOLING_KEYS = new Set(["APPLE_ID", "ASC_APP_ID", "GOOGLE_SERVICE_ACCOUNT_KEY_PATH"]);

describe(".env.example", () => {
  it("documents every declared variable", () => {
    const documented = new Set(exampleKeys());
    const undocumented = allDeclaredKeys.filter(
      (key) => key !== "NODE_ENV" && !documented.has(key),
    );
    expect(undocumented).toEqual([]);
  });

  it("does not document variables that no longer exist", () => {
    const declared = new Set(allDeclaredKeys);
    const orphans = exampleKeys().filter(
      (key) => !declared.has(key) && !BUILD_TOOLING_KEYS.has(key),
    );
    expect(orphans).toEqual([]);
  });

  it("keeps every build-tooling exemption genuinely out of the runtime schema", () => {
    // The exemption must not become a way to smuggle a runtime variable past the
    // pairing test above: if one of these ever gains a runtime meaning, it
    // belongs in the schema and the exemption has to go.
    const declared = new Set(allDeclaredKeys);
    expect([...BUILD_TOOLING_KEYS].filter((key) => declared.has(key))).toEqual([]);
  });

  it("documents every build-tooling exemption it claims", () => {
    // The other direction: an exemption for a variable nobody documents is a
    // stale entry, and stale entries are how an allowlist stops meaning anything.
    const documented = new Set(exampleKeys());
    expect([...BUILD_TOOLING_KEYS].filter((key) => !documented.has(key))).toEqual([]);
  });

  it("has a comment line immediately above every variable", () => {
    const lines = readFileSync(EXAMPLE_PATH, "utf8").split("\n");
    const missingComment: string[] = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#") || !trimmed.includes("=")) return;
      const previous = (lines[index - 1] ?? "").trim();
      if (!previous.startsWith("#")) missingComment.push(trimmed.split("=")[0]!);
    });
    expect(missingComment).toEqual([]);
  });

  it("ships no real-looking secrets", () => {
    const contents = readFileSync(EXAMPLE_PATH, "utf8");
    expect(contents).not.toMatch(/re_[A-Za-z0-9]{16,}/);
    expect(contents).not.toMatch(/sk_live_/);
    expect(contents).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

describe("declarations", () => {
  it("keeps server secrets out of the public variable sets", () => {
    for (const key of [...keysOf(clientVars), ...keysOf(mobileVars)]) {
      expect(key).toMatch(/^(NEXT_PUBLIC_|EXPO_PUBLIC_)/);
    }
  });

  it("never marks a public variable as secret", () => {
    for (const spec of [...Object.values(clientVars), ...Object.values(mobileVars)]) {
      expect(spec.secret).toBe(false);
    }
  });

  it("gives every variable a non-trivial hint", () => {
    for (const spec of [
      ...Object.values(serverVars),
      ...Object.values(clientVars),
      ...Object.values(mobileVars),
    ]) {
      expect(spec.hint.length).toBeGreaterThan(20);
    }
  });

  it("exposes pdx1 as the only beta storage region", () => {
    expect(STORAGE_REGIONS).toEqual(["pdx1"]);
  });
});

describe("server schema behaviour", () => {
  const server = () => createEnv({ id: "server", vars: serverVars, runtimeEnv: {} });

  it("defaults the storage region to pdx1", () => {
    expect(server().STORAGE_DEFAULT_REGION).toBe("pdx1");
  });

  it("defaults UploadThing objects to private", () => {
    expect(server().UPLOADTHING_ACL).toBe("private");
  });

  it("defaults the email display name", () => {
    expect(server().RESEND_FROM_NAME).toBe("PartyBooth");
  });

  it("rejects a Better Auth secret that is too short", () => {
    const env = createEnv({
      id: "server",
      vars: serverVars,
      runtimeEnv: { BETTER_AUTH_SECRET: "too-short" },
    });
    expect(() => env.BETTER_AUTH_SECRET).toThrow(/at least 32 characters/);
  });

  it("rejects a Resend key without the re_ prefix", () => {
    const env = createEnv({
      id: "server",
      vars: serverVars,
      runtimeEnv: { RESEND_API_KEY: "sk_test_nope" },
    });
    expect(() => env.RESEND_API_KEY).toThrow(/RESEND_API_KEY/);
  });

  it("parses the admin allowlist into normalised emails", () => {
    const env = createEnv({
      id: "server",
      vars: serverVars,
      runtimeEnv: { ADMIN_EMAIL_ALLOWLIST: " Corey@Example.com , second@example.com ," },
    });
    expect(env.ADMIN_EMAIL_ALLOWLIST).toEqual(["corey@example.com", "second@example.com"]);
  });

  it("requires the demo OTP to be six digits", () => {
    const bad = createEnv({
      id: "server",
      vars: serverVars,
      runtimeEnv: { DEMO_LOGIN_OTP: "12345" },
    });
    expect(() => bad.DEMO_LOGIN_OTP).toThrow(/six digits/);

    const good = createEnv({
      id: "server",
      vars: serverVars,
      runtimeEnv: { DEMO_LOGIN_OTP: "123456" },
    });
    expect(good.DEMO_LOGIN_OTP).toBe("123456");
  });

  it("rejects non-http URLs", () => {
    const env = createEnv({
      id: "server",
      vars: serverVars,
      runtimeEnv: { SITE_URL: "ftp://example.com" },
    });
    expect(() => env.SITE_URL).toThrow(/SITE_URL/);
  });
});

describe("envVar", () => {
  it("defaults secret to false", () => {
    expect(envVar(clientVars.NEXT_PUBLIC_SITE_URL.schema, "x".repeat(30)).secret).toBe(false);
  });
});
