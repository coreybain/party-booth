/**
 * The timing rule, which is the whole feature.
 *
 * The line in TODO.md is "permission prompt at the right moment (after first
 * successful join, not app launch)". A bug here costs one system prompt per
 * install and is unrecoverable in the app — so it is a table, not a thing
 * somebody checks on a phone once.
 */

import { describe, expect, it } from "vitest";

import { nextRegistrationStep, shouldSendToken, type RegistrationInputs } from "./registration";

function inputs(overrides: Partial<RegistrationInputs> = {}): RegistrationInputs {
  return {
    configured: true,
    signedIn: true,
    permission: "undetermined",
    canAskAgain: true,
    armed: false,
    ...overrides,
  };
}

describe("nextRegistrationStep", () => {
  it("does nothing at launch, however keen the app is", () => {
    // The bug this exists to prevent: a fresh install that prompts on the splash
    // screen, is refused by somebody who has no idea what the app is, and can
    // never ask again.
    expect(nextRegistrationStep(inputs())).toBe("idle");
  });

  it("prompts once a join has armed it", () => {
    expect(nextRegistrationStep(inputs({ armed: true }))).toBe("prompt");
  });

  it("registers without prompting when permission is already granted", () => {
    // Even unarmed: the token rotates under the app, so a launch by somebody who
    // said yes last week has to re-register or their notifications go nowhere.
    expect(nextRegistrationStep(inputs({ permission: "granted", armed: false }))).toBe("register");
  });

  it("accepts a refusal the OS will not revisit", () => {
    expect(
      nextRegistrationStep(inputs({ permission: "denied", canAskAgain: false, armed: true })),
    ).toBe("blocked");
  });

  it("may ask again where the OS allows it and a join has happened", () => {
    // Android 13 leaves `denied` + `canAskAgain` after a dismissal rather than a
    // refusal; iOS never does, so this branch is Android's alone.
    expect(
      nextRegistrationStep(inputs({ permission: "denied", canAskAgain: true, armed: true })),
    ).toBe("prompt");
  });

  it("does nothing at all without an EAS project", () => {
    // No project id means no token can be minted. Prompting for a permission the
    // app cannot use is the rudest possible no-op.
    expect(
      nextRegistrationStep(inputs({ configured: false, armed: true, permission: "granted" })),
    ).toBe("idle");
  });

  it("does nothing while signed out", () => {
    // A token is stored against an account. There is nobody to store it against
    // yet, and the join that arms the prompt cannot happen signed out either.
    expect(
      nextRegistrationStep(inputs({ signedIn: false, armed: true, permission: "granted" })),
    ).toBe("idle");
  });
});

describe("shouldSendToken", () => {
  it("sends on the first launch of the process", () => {
    expect(shouldSendToken("ExponentPushToken[a]", { thisLaunch: false })).toBe(true);
  });

  it("sends again when the token has rotated under the app", () => {
    expect(
      shouldSendToken("ExponentPushToken[b]", { token: "ExponentPushToken[a]", thisLaunch: true }),
    ).toBe(true);
  });

  it("does not re-send the same token on every render", () => {
    expect(
      shouldSendToken("ExponentPushToken[a]", { token: "ExponentPushToken[a]", thisLaunch: true }),
    ).toBe(false);
  });
});
