import { withSentry } from "@sentry/react-native/expo";

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
 * `expo export` and `tsc` working offline with no credentials. `pnpm env:doctor` at
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

/** Fallback only — replaced as soon as EXPO_PUBLIC_SITE_URL is set. */
const PLACEHOLDER_SITE_HOST = "partybooth.app";

/**
 * Host used for iOS associated domains and Android App Links, derived from the site
 * URL so the QR universal link (`https://<host>/join/<token>`) opens the app.
 */
function resolveSiteHost(): string {
  const raw = process.env.EXPO_PUBLIC_SITE_URL;
  if (!raw) return PLACEHOLDER_SITE_HOST;
  try {
    return new URL(raw).host;
  } catch {
    return PLACEHOLDER_SITE_HOST;
  }
}

const siteHost = resolveSiteHost();

/** Set once `eas init` has run; until then EAS Update and push tokens stay disabled. */
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;

/** Expo account or organisation that owns the EAS project. */
const easOwner = process.env.EXPO_OWNER;

const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;

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

export default ({ config }: ConfigContext): ExpoConfig => {
  const expo: ExpoConfig = {
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
          // Joining is by six-digit code / universal link, not by in-app
          // scanning. Leaving the scanner off keeps the barcode framework — and
          // the questions Play asks about it — out of the binary.
          barcodeScannerEnabled: false,
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
