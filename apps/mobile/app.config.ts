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

const permissionCopy = {
  camera: "PartyBooth uses the camera so you can take photos and videos at the party you joined.",
  microphone: "PartyBooth records audio with your videos so party clips have sound.",
  photoLibrary:
    "PartyBooth lets you choose existing photos and videos to share with the party, when the host allows it.",
  photoLibraryAdd: "PartyBooth saves the photos and videos you capture back to your own library.",
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
    // Build numbers are managed by EAS (`cli.appVersionSource: "remote"` in eas.json),
    // so no buildNumber / versionCode is pinned here.
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
        // No proprietary cryptography — avoids the export-compliance questionnaire
        // on every single TestFlight/App Store upload.
        ITSAppUsesNonExemptEncryption: false,
      },
    },

    android: {
      package: BUNDLE_ID,
      // Edge-to-edge is unconditional from SDK 54 onwards — there is no longer a flag.
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#12091B",
      },
      permissions: [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.POST_NOTIFICATIONS",
      ],
      // Autolinked libraries like to add these; PartyBooth never reads arbitrary
      // storage and Play flags them as sensitive.
      blockedPermissions: [
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
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
          recordAudioAndroid: true,
          // Sprint 2 joins by six-digit code / universal link, not by in-app scanning.
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
