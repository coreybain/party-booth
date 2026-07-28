/**
 * Persistence for the half of the profile that has no home on the server yet.
 *
 * Storage is `expo-secure-store`, which is already a dependency (it backs the Better
 * Auth session) rather than a new one — CONTRIBUTING.md is explicit that launch week
 * does not take on tooling that does not remove more work than it adds. None of what
 * is written here is a secret; the keychain is simply the key/value store this app
 * already links.
 *
 * Every function swallows its errors. The keychain can genuinely be unavailable — a
 * device that has never been unlocked since boot, a simulator with a broken keychain
 * — and losing a remembered avatar must degrade to "pick it again", never to a crash
 * on the first screen after sign-in.
 *
 * The pure half (shape, key derivation, parsing) lives in `./profile` and is where
 * the tests are.
 */

import * as SecureStore from "expo-secure-store";

import { captureHandledError } from "./sentry";
import {
  EMPTY_LOCAL_PROFILE,
  localProfileKey,
  parseLocalProfile,
  serialiseLocalProfile,
  type LocalProfile,
} from "./profile";

export async function loadLocalProfile(userId: string): Promise<LocalProfile> {
  try {
    return parseLocalProfile(await SecureStore.getItemAsync(localProfileKey(userId)));
  } catch (error) {
    captureHandledError(error, { scope: "local-profile.load" });
    return EMPTY_LOCAL_PROFILE;
  }
}

export async function saveLocalProfile(userId: string, profile: LocalProfile): Promise<void> {
  try {
    await SecureStore.setItemAsync(localProfileKey(userId), serialiseLocalProfile(profile));
  } catch (error) {
    captureHandledError(error, { scope: "local-profile.save" });
  }
}

/** Used by sign-out so the next person on this phone starts clean. */
export async function clearLocalProfile(userId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(localProfileKey(userId));
  } catch (error) {
    captureHandledError(error, { scope: "local-profile.clear" });
  }
}
