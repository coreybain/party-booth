/**
 * When the app is allowed to ask for notifications, and when it should register.
 *
 * Split out from the provider because the *timing* is the whole requirement and
 * it is the only part that can be got wrong silently. PLAN.md's line is "push
 * notifications: upload failure/recovery, event open/close, pending-queue
 * threshold"; TODO.md's is that the prompt happens **after the first successful
 * join, not at app launch**. That is not politeness — iOS gives an app exactly
 * one system prompt per install, and a guest who sees it on the splash screen,
 * before they have any idea what PartyBooth is, taps Don't Allow and can never
 * be asked again. Asking a beat after they have walked into a party costs the
 * same one chance at a far better moment.
 *
 * Everything here is a pure function of a snapshot, so the whole timing rule is
 * a table in a unit test rather than something you find out about on a phone.
 */

/** The OS's answer, normalised across the two platforms. */
export type PushPermission = "granted" | "denied" | "undetermined";

export interface PushPermissionSnapshot {
  readonly permission: PushPermission;
  /**
   * Whether the OS will still show a prompt. iOS says `false` once the guest has
   * answered, whatever they answered; Android 13+ says `false` after two
   * dismissals. When it is `false` and we are not granted, the only route left
   * is the system settings app.
   */
  readonly canAskAgain: boolean;
}

export interface RegistrationInputs {
  /** The build has an EAS project id — without one there is no token to mint. */
  readonly configured: boolean;
  /** Convex says this caller is authenticated. A token belongs to an account. */
  readonly signedIn: boolean;
  readonly permission: PushPermission;
  readonly canAskAgain: boolean;
  /** A join has succeeded on this device at some point. Persisted. */
  readonly armed: boolean;
}

export type RegistrationStep =
  /** Nothing to do: unconfigured, signed out, or nobody has joined anything yet. */
  | "idle"
  /** Ask the OS. Only ever reached once, and only after a join. */
  | "prompt"
  /** Permission is in hand — mint a token and send it to Convex. */
  | "register"
  /** Refused, and the OS will not ask again. Settings is the only way back. */
  | "blocked";

/**
 * What the app should do next about push, given everything it currently knows.
 *
 * The order of the checks is the interesting part:
 *
 * 1. **Configuration and sign-in first.** A token is minted against an EAS
 *    project and stored against an account; neither is optional, and neither is
 *    a reason to bother the guest.
 * 2. **Granted beats armed.** A guest who allowed notifications last week is
 *    registered on this launch without any join, because the token rotates under
 *    the app and a stale row is a notification that goes nowhere.
 * 3. **Armed gates only the prompt.** This is the rule the whole module exists
 *    for.
 */
export function nextRegistrationStep(inputs: RegistrationInputs): RegistrationStep {
  if (!inputs.configured || !inputs.signedIn) return "idle";
  if (inputs.permission === "granted") return "register";
  if (inputs.permission === "denied")
    return inputs.canAskAgain && inputs.armed ? "prompt" : "blocked";
  return inputs.armed ? "prompt" : "idle";
}

/**
 * Whether a freshly-minted token needs sending to the server.
 *
 * A token that has not changed is still re-sent **once per launch** — the
 * mutation refreshes `lastSeenAt` and re-enables a row the delivery path had
 * switched off after a `DeviceNotRegistered`, which is exactly the state a phone
 * that has just come back from a reinstall is in. What this stops is re-sending
 * on every render of every screen.
 */
export function shouldSendToken(
  token: string,
  lastSent: { readonly token?: string | undefined; readonly thisLaunch: boolean },
): boolean {
  if (!lastSent.thisLaunch) return true;
  return lastSent.token !== token;
}
