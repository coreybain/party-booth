import { describe, expect, it } from "vitest";

import type { ExportedConfig } from "expo/config-plugins";

import resolveExpoConfig, {
  ANDROID_GRADLE_JVM_ARGS,
  IOS_SCENE_DELEGATE_SOURCE,
  IOS_SCENE_MANIFEST,
  migrateAppDelegateToSceneLifecycle,
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

describe("managed camera configuration", () => {
  it("includes the native barcode scanner used by QR joining", () => {
    const config = resolveExpoConfig({
      projectRoot: "/tmp/partybooth",
      staticConfigPath: null,
      packageJsonPath: "/tmp/partybooth/package.json",
      config: { name: "PartyBooth", slug: "partybooth" },
    }) as ExportedConfig;

    expect(config.plugins).toContainEqual([
      "expo-camera",
      expect.objectContaining({ barcodeScannerEnabled: true }),
    ]);
  });
});

describe("production app links", () => {
  it("points iOS universal links and Android App Links at partybooth.dev", () => {
    const config = resolveExpoConfig({
      projectRoot: "/tmp/partybooth",
      staticConfigPath: null,
      packageJsonPath: "/tmp/partybooth/package.json",
      config: { name: "PartyBooth", slug: "partybooth" },
    }) as ExportedConfig;

    expect(config.ios?.associatedDomains).toContain("applinks:www.partybooth.dev");
    expect(config.android?.intentFilters).toContainEqual(
      expect.objectContaining({
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: "https",
            host: "www.partybooth.dev",
            pathPrefix: "/join",
          },
        ],
      }),
    );
  });
});

describe("EAS project linkage", () => {
  it("resolves the checked-in PartyBooth project without local environment files", () => {
    const config = resolveExpoConfig({
      projectRoot: "/tmp/partybooth",
      staticConfigPath: null,
      packageJsonPath: "/tmp/partybooth/package.json",
      config: { name: "PartyBooth", slug: "partybooth" },
    }) as ExportedConfig;

    expect(config.owner).toBe("spiritdevs");
    expect(config.extra?.eas).toEqual({
      projectId: "d05e1c88-901c-43a2-afc8-8e20b3abbd0a",
    });
  });
});

describe("managed iOS scene lifecycle configuration", () => {
  it("moves React Native startup out of Expo's SDK 57 AppDelegate block", () => {
    const generatedAppDelegate = `class AppDelegate {
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
}`;

    const migrated = migrateAppDelegateToSceneLifecycle(generatedAppDelegate);

    expect(migrated).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    expect(migrated).toContain("React Native is started by `SceneDelegate`");
    expect(migrateAppDelegateToSceneLifecycle(migrated)).toBe(migrated);
  });

  it("declares one scene configuration and preserves cold-start link routing", () => {
    expect(IOS_SCENE_MANIFEST).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    });
    expect(IOS_SCENE_DELEGATE_SOURCE).toContain("connectionOptions.urlContexts.first?.url");
    expect(IOS_SCENE_DELEGATE_SOURCE).toContain("RCTLinkingManager.application");
  });

  it("registers each native iOS modifier in the managed-config pipeline", () => {
    const config = resolveExpoConfig({
      projectRoot: "/tmp/partybooth",
      staticConfigPath: null,
      packageJsonPath: "/tmp/partybooth/package.json",
      config: { name: "PartyBooth", slug: "partybooth" },
    }) as ExportedConfig;

    expect(config.mods?.ios?.infoPlist).toBeTypeOf("function");
    expect(config.mods?.ios?.appDelegate).toBeTypeOf("function");
    expect(config.mods?.ios?.xcodeproj).toBeTypeOf("function");
    expect(config.mods?.ios?.dangerous).toBeTypeOf("function");
  });
});
