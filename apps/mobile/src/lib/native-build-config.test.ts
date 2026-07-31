import { describe, expect, it } from "vitest";

import type { ExportedConfig } from "expo/config-plugins";

import resolveExpoConfig, {
  ANDROID_GRADLE_JVM_ARGS,
  setAndroidGradleJvmArgs,
} from "../../app.config";

describe("managed Android build configuration", () => {
  it("replaces Expo's release-build Metaspace ceiling without duplicating the property", () => {
    const properties = [
      { type: "comment" as const, value: "Project-wide Gradle settings." },
      {
        type: "property" as const,
        key: "org.gradle.jvmargs",
        value: "-Xmx2048m -XX:MaxMetaspaceSize=512m",
      },
      { type: "property" as const, key: "org.gradle.parallel", value: "true" },
    ];

    const updated = setAndroidGradleJvmArgs(properties);

    expect(
      updated.filter((item) => item.type === "property" && item.key === "org.gradle.jvmargs"),
    ).toEqual([
      {
        type: "property",
        key: "org.gradle.jvmargs",
        value: ANDROID_GRADLE_JVM_ARGS,
      },
    ]);
    expect(updated).toContainEqual({
      type: "property",
      key: "org.gradle.parallel",
      value: "true",
    });
  });

  it("registers the Gradle property writer in the Expo managed-config pipeline", () => {
    const config = resolveExpoConfig({
      projectRoot: "/tmp/partybooth",
      staticConfigPath: null,
      packageJsonPath: "/tmp/partybooth/package.json",
      config: { name: "PartyBooth", slug: "partybooth" },
    }) as ExportedConfig;

    expect(config.mods?.android?.gradleProperties).toBeTypeOf("function");
  });
});
