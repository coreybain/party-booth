/**
 * Public iOS distribution details shared by Smart App Banners and explicit
 * "open the app" controls.
 *
 * The numeric ID is the same App Store Connect record used by
 * `apps/mobile/eas.json`. Keeping the destination country-neutral lets Apple
 * select the guest's storefront.
 */
export const PARTYBOOTH_APP_STORE_ID = "6797317089";
export const PARTYBOOTH_APP_STORE_URL =
  `https://apps.apple.com/app/id${PARTYBOOTH_APP_STORE_ID}` as const;

/** Open the app's entry gate, which restores the server-selected active event. */
export const PARTYBOOTH_APP_URL = "partybooth://";

/**
 * Delay the store fallback long enough for iOS to background Safari when the
 * scheme is installed. The visibility/pagehide listeners cancel this timer as
 * soon as the app wins the handoff.
 */
export const APP_STORE_FALLBACK_DELAY_MS = 1_300;
