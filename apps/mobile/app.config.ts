import fs from "node:fs";
import path from "node:path";

import { withSentry } from "@sentry/react-native/expo";
import {
  AndroidConfig,
  IOSConfig,
  withAppDelegate,
  withAndroidManifest,
  withDangerousMod,
  withGradleProperties,
  withInfoPlist,
  withXcodeProject,
  type ConfigPlugin,
} from "expo/config-plugins";

import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Expo app config for PartyBooth.
 *
 * This file runs in Node at config-resolution time (`expo start`, `expo prebuild`,
 * EAS Build), so reading `process.env` directly is correct here — this is the one
 * layer that is allowed to. Everything the *app* needs at runtime goes through
 * `src/env.ts` instead.
 *
 * Nothing here fails when a variable is missing: placeholders keep `expo config`,
 * `expo export` and `tsc` working offline with no credentials. `bun run env:doctor` at
 * the repo root lists what still needs filling in.
 */

/** Bundle identifier / application id. Must match the Apple App ID and Play listing. */
const BUNDLE_ID = "com.partybooth.app";

/** URL scheme for `partybooth://` deep links. Also used as the Better Auth callback scheme. */
const SCHEME = "partybooth";

/**
 * Minimum OS versions, per PLAN.md ("iOS 17+ / Android 10+").
 * Android 10 is API level 29.
 */
const IOS_DEPLOYMENT_TARGET = "17.0";
const ANDROID_MIN_SDK = 29;

/** Canonical production host; overridden by EXPO_PUBLIC_SITE_URL for local builds. */
const DEFAULT_SITE_HOST = "www.partybooth.dev";

/**
 * Host used for iOS associated domains and Android App Links, derived from the site
 * URL so the QR universal link (`https://<host>/join/<token>`) opens the app.
 */
function resolveSiteHost(): string {
  const raw = process.env.EXPO_PUBLIC_SITE_URL;
  if (!raw) return DEFAULT_SITE_HOST;
  try {
    return new URL(raw).host;
  } catch {
    return DEFAULT_SITE_HOST;
  }
}

const siteHost = resolveSiteHost();

/** EAS project linkage. Environment overrides keep forks able to use their own project. */
const easProjectId =
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? "d05e1c88-901c-43a2-afc8-8e20b3abbd0a";

/** Expo account or organisation that owns the EAS project. */
const easOwner = process.env.EXPO_OWNER ?? "spiritdevs";

const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;

/** Profiles that produce binaries uploaded to App Store Connect or Google Play. */
const isStoreBuild = ["internal", "production"].includes(process.env.EAS_BUILD_PROFILE ?? "");

/**
 * Purpose strings, in plain honest English.
 *
 * App Review rejects a build whose strings are generic ("This app needs camera
 * access"), and it rejects one whose strings describe something the app does not
 * do. Each of these names the **feature** the permission is for and the **limit**
 * on it, because that is what the guideline asks for and because it is what a
 * guest at a party actually wants to know before tapping Allow.
 *
 * Two are deliberately narrower than they could be:
 *
 * - **Photo library** says "when the host allows it", because the per-event
 *   `allowLibraryImport` flag really can turn the button off, and a string that
 *   promised the feature unconditionally would be wrong half the time.
 * - **Photo library add** is only claimed because the string is required the
 *   moment anything in the dependency tree can write to the roll. Nothing in
 *   the app saves captures back today — the re-encoded original goes to the
 *   party, not to the camera roll — so the wording is about what the *guest*
 *   chooses to save. **Owner note:** if this stays unused through review, the
 *   honest thing is to drop `NSPhotoLibraryAddUsageDescription` entirely rather
 *   than declare a capability we do not use.
 */
const permissionCopy = {
  camera:
    "PartyBooth uses the camera so you can take photos and record videos at the party you joined. It is only used while the camera screen is open.",
  microphone:
    "PartyBooth uses the microphone to record sound with your party videos. It is only used while you are holding the shutter to record.",
  photoLibrary:
    "PartyBooth lets you choose an existing photo to share with the party you joined, when the host has allowed it.",
  photoLibraryAdd:
    "PartyBooth asks for this so you can save a photo from the party back to your own library.",
} as const;

const EXPO_VIDEO_FULLSCREEN_ACTIVITY = "expo.modules.video.FullscreenPlayerActivity";

/**
 * Expo's generated project defaults Gradle's daemon to 512 MiB of Metaspace.
 * A full release bundle exhausts that while Android Lint analyses the native
 * dependency graph, so keep the existing 2 GiB heap and give class metadata a
 * realistic release-build ceiling. This lives in a config plugin because the
 * checked-in source of truth is managed config, not a generated android folder.
 */
export const ANDROID_GRADLE_JVM_ARGS = "-Xmx2048m -XX:MaxMetaspaceSize=1024m";

export function setAndroidGradleJvmArgs(
  properties: Parameters<typeof AndroidConfig.BuildProperties.updateAndroidBuildProperty>[0],
) {
  return AndroidConfig.BuildProperties.updateAndroidBuildProperty(
    properties,
    "org.gradle.jvmargs",
    ANDROID_GRADLE_JVM_ARGS,
  );
}

const withAndroidReleaseBuildMemory: ConfigPlugin = (config) =>
  withGradleProperties(config, (config) => {
    config.modResults = setAndroidGradleJvmArgs(config.modResults);
    return config;
  });

/**
 * Keep the merged Android manifest honest about Picture in Picture.
 *
 * `expo-video` 57 removes PiP from the app's MainActivity when its plugin option
 * is false, but the library contributes a separate FullscreenPlayerActivity
 * with PiP set to true later during Gradle's manifest merge. A main-manifest
 * override is the only declaration with enough priority to replace that value.
 */
const withDisabledAndroidVideoPictureInPicture: ConfigPlugin = (config) =>
  withAndroidManifest(config, (config) => {
    const manifest = AndroidConfig.Manifest.ensureToolsAvailable(config.modResults);
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const activities = application.activity ?? [];
    let fullscreenActivity = activities.find(
      (activity) => activity.$["android:name"] === EXPO_VIDEO_FULLSCREEN_ACTIVITY,
    );

    if (!fullscreenActivity) {
      fullscreenActivity = { $: { "android:name": EXPO_VIDEO_FULLSCREEN_ACTIVITY } };
      application.activity = [...activities, fullscreenActivity];
    }

    fullscreenActivity.$["android:supportsPictureInPicture"] = "false";
    fullscreenActivity.$["tools:replace"] = "android:supportsPictureInPicture";
    config.modResults = manifest;
    return config;
  });

const LEGACY_APP_DELEGATE_BOOTSTRAP = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const SCENE_APP_DELEGATE_BOOTSTRAP = `    // The window is created and React Native is started by \`SceneDelegate\` under the
    // scene-based life cycle (required by the iOS 27 SDK).`;

export const IOS_SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: "Default Configuration",
        UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
      },
    ],
  },
};

/**
 * SDK 57 still emits an AppDelegate-owned window. Move startup to SceneDelegate
 * while preserving Expo's factory initialization in didFinishLaunching.
 */
export function migrateAppDelegateToSceneLifecycle(contents: string): string {
  if (contents.includes(SCENE_APP_DELEGATE_BOOTSTRAP)) {
    return contents;
  }

  if (!contents.includes(LEGACY_APP_DELEGATE_BOOTSTRAP)) {
    throw new Error(
      "Could not migrate the generated iOS AppDelegate to UIScene: Expo's startup block changed.",
    );
  }

  return contents.replace(LEGACY_APP_DELEGATE_BOOTSTRAP, SCENE_APP_DELEGATE_BOOTSTRAP);
}

/**
 * Temporary SDK 57 compatibility layer based on Expo's upstream SceneDelegate.
 * Remove this plugin after the installed Expo release generates scene lifecycle
 * support itself.
 */
export const IOS_SCENE_DELEGATE_SOURCE = `internal import Expo
internal import ExpoModulesCore
import React

@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory else {
      fatalError(
        "SceneDelegate couldn't start React Native because AppDelegate has no React Native factory."
      )
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window

    // Preserve compatibility with modules that still read the app delegate's window.
    appDelegate.window = window

    // Scene lifecycle cold starts carry links in connectionOptions. Rebuild the
    // launch options shape that React Native's Linking.getInitialURL() expects.
    let browsingWebActivity = connectionOptions.userActivities.first {
      $0.activityType == NSUserActivityTypeBrowsingWeb
    }
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: Self.launchOptions(
        url: connectionOptions.urlContexts.first?.url,
        userActivity: browsingWebActivity
      )
    )

    Self.route(urlContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { Self.route(userActivity: $0) }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    ExpoAppDelegateSubscriberManager.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    Self.route(urlContexts: URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    Self.route(userActivity: userActivity)
  }
}

extension SceneDelegate {
  static func launchOptions(
    url: URL?,
    userActivity: NSUserActivity?
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url {
      let urlKey = UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")
      launchOptions[urlKey] = url
    }
    if let userActivity {
      let userActivityDictionaryKey = UIApplication.LaunchOptionsKey(
        rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey"
      )
      launchOptions[userActivityDictionaryKey] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": userActivity,
      ]
    }
    return launchOptions.isEmpty ? nil : launchOptions
  }

  static func route(urlContexts: Set<UIOpenURLContext>) {
    for context in urlContexts {
      let options = openURLOptions(from: context.options)
      _ = ExpoAppDelegateSubscriberManager.application(
        UIApplication.shared,
        open: context.url,
        options: options
      )
      RCTLinkingManager.application(
        UIApplication.shared,
        open: context.url,
        options: options
      )
    }
  }

  static func route(userActivity: NSUserActivity) {
    _ = ExpoAppDelegateSubscriberManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
    RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  private static func openURLOptions(
    from sceneOptions: UIScene.OpenURLOptions
  ) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let sourceApplication = sceneOptions.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = sceneOptions.annotation {
      options[.annotation] = annotation
    }
    options[.openInPlace] = sceneOptions.openInPlace
    return options
  }
}
`;

export const withIosSceneLifecycle: ConfigPlugin = (config) => {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = IOS_SCENE_MANIFEST;
    return config;
  });

  config = withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      throw new Error("PartyBooth's UIScene plugin requires Expo's Swift AppDelegate template.");
    }
    config.modResults.contents = migrateAppDelegateToSceneLifecycle(config.modResults.contents);
    return config;
  });

  config = withXcodeProject(config, (config) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
    config.modResults = IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/SceneDelegate.swift`,
      groupName: projectName,
      project: config.modResults,
      verbose: true,
    });
    return config;
  });

  return withDangerousMod(config, [
    "ios",
    async (config) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
      const sceneDelegatePath = path.join(
        config.modRequest.platformProjectRoot,
        projectName,
        "SceneDelegate.swift",
      );
      await fs.promises.writeFile(sceneDelegatePath, IOS_SCENE_DELEGATE_SOURCE);
      return config;
    },
  ]);
};

export default ({ config }: ConfigContext): ExpoConfig => {
  let expo: ExpoConfig = {
    ...config,
    name: "PartyBooth",
    slug: "partybooth",
    version: "0.1.0",
    scheme: SCHEME,
    // Both orientations are launch scope (PLAN.md → "Camera").
    orientation: "default",
    userInterfaceStyle: "dark",
    icon: "./assets/icon.png",
    /*
     * ## Versioning scheme
     *
     * `version` is the **marketing version** — what a guest sees in Settings →
     * About and what App Store Connect calls the version number. It is bumped by
     * hand, here, and only for a release worth naming. 0.1.0 is the private
     * beta; the party build is whatever this says on 1 August.
     *
     * `buildNumber` (iOS) and `versionCode` (Android) are **deliberately not
     * pinned in this file**. `eas.json` sets `cli.appVersionSource: "remote"`
     * and `autoIncrement: true` on the store profiles, so EAS holds the counter
     * and bumps it per build. That matters more than it sounds: App Store
     * Connect refuses a second upload with a build number it has already seen,
     * and the failure arrives *after* the upload — so a number kept in a file
     * that two people can edit is a rejected submission on the day it matters.
     * `eas build:version:get` reads the current values.
     *
     * `runtimeVersion: { policy: "appVersion" }` ties OTA update compatibility
     * to the marketing version, so a JS-only fix ships to the build it was
     * written against and a native change forces a new binary.
     */
    runtimeVersion: { policy: "appVersion" },
    ...(easOwner ? { owner: easOwner } : {}),

    ios: {
      bundleIdentifier: BUNDLE_ID,
      supportsTablet: false,
      // QR codes point at https://<host>/join/<token>; this makes iOS open the app.
      associatedDomains: [`applinks:${siteHost}`],
      infoPlist: {
        // Duplicated by the config plugins below; kept explicit so `expo prebuild`
        // output is legible and a plugin regression cannot silently drop a string
        // (App Review rejects builds with missing purpose strings).
        NSCameraUsageDescription: permissionCopy.camera,
        NSMicrophoneUsageDescription: permissionCopy.microphone,
        NSPhotoLibraryUsageDescription: permissionCopy.photoLibrary,
        NSPhotoLibraryAddUsageDescription: permissionCopy.photoLibraryAdd,
        /*
         * No proprietary cryptography — avoids the export-compliance
         * questionnaire on every single TestFlight/App Store upload.
         *
         * This is the correct answer and not a shortcut: the app's only
         * cryptography is HTTPS (an OS-provided, exempt use) and SHA-256 from
         * `expo-crypto` for upload checksums, which is a hash rather than
         * encryption. Nothing here implements or bundles an encryption
         * algorithm. Answer "No" to the ECCN question in App Store Connect to
         * match — see `docs/store/ios-submission.md`.
         */
        ITSAppUsesNonExemptEncryption: false,
      },
    },

    android: {
      package: BUNDLE_ID,
      // Edge-to-edge is unconditional from SDK 54 onwards — there is no longer a flag.
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        // The brand accent, matching the iOS icon's field. The glyph's lens and
        // flash are punched *through* the foreground (see `scripts/make-icons.mjs`),
        // so this colour shows through them on every launcher mask shape.
        backgroundColor: "#FF2E88",
      },
      /*
       * Two permissions, and deliberately not four.
       *
       * `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` used to be here, and they are
       * exactly the pair current Play policy restricts to apps that need broad,
       * persistent access to a device's whole media library. PartyBooth needs no
       * such thing: library import is a **single** image chosen through
       * `expo-image-picker`, which routes through the Android system photo
       * picker and hands back one URI with no permission at all, and there is no
       * video-library import anywhere in the product. Declaring them bought
       * nothing and put the release in the path of a policy rejection with a
       * declaration form attached.
       *
       * They are listed under `blockedPermissions` below rather than merely
       * omitted, because an autolinked library adding them back to the merged
       * manifest is precisely the failure mode — verify the **release** manifest
       * (`docs/store/android-internal.md`) rather than this file.
       */
      permissions: [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.POST_NOTIFICATIONS",
      ],
      // Autolinked libraries like to add these; PartyBooth never reads arbitrary
      // storage and Play flags them as sensitive.
      blockedPermissions: [
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        // React Native adds this for its development overlay. Keep it in dev
        // builds, but never claim overlay capability in a Play-bound binary.
        ...(isStoreBuild ? ["android.permission.SYSTEM_ALERT_WINDOW"] : []),
      ],
      intentFilters: [
        {
          action: "VIEW",
          // Verified App Link — requires /.well-known/assetlinks.json served by apps/web.
          autoVerify: true,
          category: ["BROWSABLE", "DEFAULT"],
          data: [{ scheme: "https", host: siteHost, pathPrefix: "/join" }],
        },
      ],
    },

    plugins: [
      "expo-router",
      "expo-dev-client",
      "expo-secure-store",
      "expo-web-browser",
      "expo-apple-authentication",
      [
        "expo-camera",
        {
          cameraPermission: permissionCopy.camera,
          microphonePermission: permissionCopy.microphone,
          // Video is launch scope (hold the shutter to record), and a recording
          // without RECORD_AUDIO fails outright on Android rather than producing
          // a silent clip — so the camera screen gates the hold gesture on the
          // microphone permission and falls back to a tap. See `useShutter`.
          recordAudioAndroid: true,
          // Guests can join by scanning the host's QR code. This must remain
          // enabled in the native binary for CameraView to emit QR callbacks.
          barcodeScannerEnabled: true,
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission: permissionCopy.photoLibrary,
          cameraPermission: permissionCopy.camera,
        },
      ],
      [
        "expo-video",
        {
          // Both off deliberately. PiP would keep a guest's clip playing over
          // the rest of the party's gallery, and background playback is a
          // capability App Review asks you to justify — neither earns its
          // review question for a fifteen-second party video.
          supportsBackgroundPlayback: false,
          supportsPictureInPicture: false,
        },
      ],
      [
        "expo-notifications",
        {
          // The tint Android paints the small icon and the notification accent
          // with. No custom `icon` is declared: the plugin falls back to the app
          // icon, and a bespoke monochrome glyph is a design task, not a launch
          // blocker. `defaultChannel` must match the channel `src/push/adapter.ts`
          // creates, or a notification arriving before the app has ever run lands
          // on a channel the guest cannot find in system settings.
          color: "#FF2E88",
          defaultChannel: "default",
        },
      ],
      [
        "expo-build-properties",
        {
          ios: { deploymentTarget: IOS_DEPLOYMENT_TARGET },
          android: { minSdkVersion: ANDROID_MIN_SDK },
        },
      ],
    ],

    experiments: {
      typedRoutes: true,
    },

    extra: {
      ...config.extra,
      router: {},
      // `eas init` writes the real value here; the app degrades to "push disabled"
      // and "updates disabled" without it.
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
    },

    ...(easProjectId ? { updates: { url: `https://u.expo.dev/${easProjectId}` } } : {}),
  };

  expo = withAndroidReleaseBuildMemory(expo);
  expo = withDisabledAndroidVideoPictureInPicture(expo);
  expo = withIosSceneLifecycle(expo);

  // Only wrap with Sentry when the org/project slugs exist. `withSentry` adds the
  // source-map upload build phase, which fails the build if it is configured with
  // placeholders, so an unconfigured checkout must skip it entirely.
  if (sentryOrg && sentryProject) {
    return withSentry(expo, {
      organization: sentryOrg,
      project: sentryProject,
      url: process.env.SENTRY_URL ?? "https://sentry.io/",
    });
  }

  return expo;
};
