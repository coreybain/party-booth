import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createEnv,
  describeEnv,
  envAssert,
  envHas,
  envHasAll,
  envIsSet,
  envKeys,
  envOptional,
  EnvError,
  envVar,
  InvalidEnvError,
  MissingEnvError,
  resetEnvCache,
  ServerEnvAccessError,
} from "./create-env";

const vars = {
  REQUIRED_URL: envVar(z.url(), "Somewhere in a dashboard"),
  REQUIRED_SECRET: envVar(z.string().min(8), "Generate with openssl", { secret: true }),
  OPTIONAL_TOKEN: envVar(z.string().min(1).optional(), "Optional provider token"),
  WITH_DEFAULT: envVar(z.string().default("fallback"), "Has a default"),
} as const;

function makeEnv(runtimeEnv: Partial<Record<keyof typeof vars, string | undefined>>) {
  return createEnv({ id: "test", vars, runtimeEnv });
}

describe("lazy validation", () => {
  it("does not throw when constructed with an empty environment", () => {
    expect(() => makeEnv({})).not.toThrow();
  });

  it("throws only when the missing variable is actually consumed", () => {
    const env = makeEnv({ OPTIONAL_TOKEN: "abc" });
    expect(env.OPTIONAL_TOKEN).toBe("abc");
    expect(() => env.REQUIRED_URL).toThrow(MissingEnvError);
  });

  it("names the variable and its source in the error message", () => {
    const env = makeEnv({});
    let message = "";
    try {
      void env.REQUIRED_URL;
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("REQUIRED_URL");
    expect(message).toContain("Somewhere in a dashboard");
    expect(message).toContain("Set it in:");
  });

  it("reports invalid values separately from missing ones", () => {
    const env = makeEnv({ REQUIRED_URL: "not-a-url" });
    expect(() => env.REQUIRED_URL).toThrow(InvalidEnvError);
    expect(() => env.REQUIRED_URL).not.toThrow(MissingEnvError);
  });

  it("never leaks the value of a secret into the error message", () => {
    const env = makeEnv({ REQUIRED_SECRET: "short" });
    try {
      void env.REQUIRED_SECRET;
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("short");
    }
  });

  it("treats an empty string as unset", () => {
    const env = makeEnv({ REQUIRED_URL: "   " });
    expect(() => env.REQUIRED_URL).toThrow(MissingEnvError);
  });

  it("trims surrounding whitespace from values", () => {
    const env = makeEnv({ REQUIRED_URL: "  https://example.com  " });
    expect(env.REQUIRED_URL).toBe("https://example.com");
  });

  it("applies zod defaults when the variable is unset", () => {
    expect(makeEnv({}).WITH_DEFAULT).toBe("fallback");
  });

  it("rejects reads of undeclared variables", () => {
    const env = makeEnv({}) as unknown as Record<string, unknown>;
    expect(() => env["NOPE"]).toThrow(EnvError);
  });

  it("is read-only", () => {
    const env = makeEnv({}) as unknown as Record<string, unknown>;
    expect(() => {
      env["WITH_DEFAULT"] = "x";
    }).toThrow(EnvError);
    expect(() => {
      delete env["WITH_DEFAULT"];
    }).toThrow(EnvError);
  });
});

describe("non-throwing helpers", () => {
  it("envHas is false for missing and invalid values, true for valid ones", () => {
    expect(envHas(makeEnv({}), "REQUIRED_URL")).toBe(false);
    expect(envHas(makeEnv({ REQUIRED_URL: "nope" }), "REQUIRED_URL")).toBe(false);
    expect(envHas(makeEnv({ REQUIRED_URL: "https://a.example" }), "REQUIRED_URL")).toBe(true);
  });

  it("envIsSet asks about raw presence, so a default does not count as set", () => {
    // The distinction the localhost trusted-origin rail depends on: a variable
    // nobody configured must not look like a deliberate choice.
    expect(envHas(makeEnv({}), "WITH_DEFAULT")).toBe(true);
    expect(envIsSet(makeEnv({}), "WITH_DEFAULT")).toBe(false);
    expect(envIsSet(makeEnv({ WITH_DEFAULT: "chosen" }), "WITH_DEFAULT")).toBe(true);
  });

  it("envIsSet treats a blank value as unset, and an invalid one as set", () => {
    expect(envIsSet(makeEnv({ WITH_DEFAULT: "  " }), "WITH_DEFAULT")).toBe(false);
    // Set-but-malformed is still set: it is a wrong answer, not a missing one.
    expect(envIsSet(makeEnv({ REQUIRED_URL: "nope" }), "REQUIRED_URL")).toBe(true);
    expect(envHas(makeEnv({ REQUIRED_URL: "nope" }), "REQUIRED_URL")).toBe(false);
  });

  it("envHasAll requires every key", () => {
    const env = makeEnv({ REQUIRED_URL: "https://a.example" });
    expect(envHasAll(env, ["REQUIRED_URL"])).toBe(true);
    expect(envHasAll(env, ["REQUIRED_URL", "REQUIRED_SECRET"])).toBe(false);
  });

  it("envOptional returns undefined when missing but still rejects malformed values", () => {
    expect(envOptional(makeEnv({}), "REQUIRED_URL")).toBeUndefined();
    expect(() => envOptional(makeEnv({ REQUIRED_URL: "nope" }), "REQUIRED_URL")).toThrow(
      InvalidEnvError,
    );
  });

  it("envKeys lists declarations in order", () => {
    expect(envKeys(makeEnv({}))).toEqual([
      "REQUIRED_URL",
      "REQUIRED_SECRET",
      "OPTIONAL_TOKEN",
      "WITH_DEFAULT",
    ]);
  });
});

describe("envAssert", () => {
  it("passes when everything asked for is present", () => {
    const env = makeEnv({ REQUIRED_URL: "https://a.example", REQUIRED_SECRET: "longenough" });
    expect(() => envAssert(env, ["REQUIRED_URL", "REQUIRED_SECRET"])).not.toThrow();
  });

  it("aggregates every problem into one message", () => {
    const env = makeEnv({ REQUIRED_SECRET: "tiny" });
    try {
      envAssert(env, ["REQUIRED_URL", "REQUIRED_SECRET"]);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("2 problem(s)");
      expect(message).toContain("REQUIRED_URL");
      expect(message).toContain("REQUIRED_SECRET");
    }
  });
});

describe("describeEnv", () => {
  it("reports presence and requiredness without exposing values", () => {
    const report = describeEnv(makeEnv({ REQUIRED_URL: "https://a.example" }));
    const byKey = Object.fromEntries(report.map((entry) => [entry.key, entry]));

    expect(byKey["REQUIRED_URL"]).toMatchObject({ present: true, valid: true, required: true });
    expect(byKey["REQUIRED_SECRET"]).toMatchObject({
      present: false,
      valid: false,
      required: true,
      secret: true,
    });
    expect(byKey["OPTIONAL_TOKEN"]).toMatchObject({ required: false });
    expect(byKey["WITH_DEFAULT"]).toMatchObject({ required: false });
    expect(JSON.stringify(report)).not.toContain("https://a.example");
  });
});

describe("server-only guard", () => {
  it("throws when a server variable is read in a browser-like environment", () => {
    const env = createEnv({
      id: "server",
      vars: { SECRET: envVar(z.string(), "hint", { secret: true }) },
      runtimeEnv: { SECRET: "value" },
      serverOnly: true,
    });

    const globalWithWindow = globalThis as { window?: unknown };
    globalWithWindow.window = { document: {} };
    try {
      resetEnvCache(env);
      expect(() => env.SECRET).toThrow(ServerEnvAccessError);
    } finally {
      delete globalWithWindow.window;
      resetEnvCache(env);
    }

    expect(env.SECRET).toBe("value");
  });
});

describe("live process.env reads", () => {
  it("picks up values assigned after construction once the cache is cleared", () => {
    const env = createEnv({
      id: "server",
      vars: { LATE: envVar(z.string(), "set later") },
      runtimeEnv: process.env,
    });

    expect(() => env.LATE).toThrow(MissingEnvError);
    process.env["LATE"] = "arrived";
    resetEnvCache(env);
    expect(env.LATE).toBe("arrived");
    delete process.env["LATE"];
  });
});
