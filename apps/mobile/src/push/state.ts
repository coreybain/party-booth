/**
 * The two facts about push that have to survive a restart.
 *
 * - **Whether a join has ever happened on this device.** The permission prompt
 *   is armed by a join and fired by the next launch that has a session, so
 *   losing this would mean a guest who joined at the door and force-quit is
 *   never asked.
 * - **The token we last registered.** Sign-out has to *unregister* it, and the
 *   most likely reason somebody signs out on party night is that the app is
 *   misbehaving — which is precisely when asking Expo for a fresh token is least
 *   likely to work. Remembering the one we sent means the sign-out path needs
 *   nothing from the network but Convex.
 *
 * Neither is a secret: the token identifies an app installation, not a person,
 * and the arming flag is a boolean. Both live in the same document-directory
 * JSON the upload queue uses rather than in the keychain — see
 * `src/upload/device-store.ts` for why size, not sensitivity, is what decides
 * that.
 *
 * Pure parse/serialise, no filesystem, so it is unit-tested in plain Node.
 */

export interface PushDeviceState {
  /** When a join first succeeded here. Presence is what matters, not the value. */
  readonly armedAt?: number | undefined;
  /** When the OS prompt was last shown, so a refusal is not re-asked on a loop. */
  readonly promptedAt?: number | undefined;
  /** The Expo token last handed to Convex. Cleared on sign-out. */
  readonly token?: string | undefined;
}

export const EMPTY_PUSH_STATE: PushDeviceState = {};

export const PUSH_STATE_FILE_NAME = "push-state.json";

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read the stored state, tolerating everything.
 *
 * A file written by an older build, half-written by a force-quit, or absent
 * entirely all mean the same thing: start from nothing. The cost of being wrong
 * is one extra permission prompt, and the cost of throwing here is a shell that
 * will not mount.
 */
export function parsePushState(raw: string | null): PushDeviceState {
  if (raw === null || raw.trim().length === 0) return EMPTY_PUSH_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_PUSH_STATE;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_PUSH_STATE;
  const record = parsed as Record<string, unknown>;

  const token = record.token;
  return {
    armedAt: readNumber(record, "armedAt"),
    promptedAt: readNumber(record, "promptedAt"),
    token: typeof token === "string" && token.length > 0 ? token : undefined,
  };
}

export function serialisePushState(state: PushDeviceState): string {
  return JSON.stringify({
    ...(state.armedAt === undefined ? {} : { armedAt: state.armedAt }),
    ...(state.promptedAt === undefined ? {} : { promptedAt: state.promptedAt }),
    ...(state.token === undefined ? {} : { token: state.token }),
  });
}

/** Whether the permission prompt has been earned — i.e. a join has happened. */
export function isArmed(state: PushDeviceState): boolean {
  return state.armedAt !== undefined;
}
