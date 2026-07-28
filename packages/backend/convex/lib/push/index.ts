import { envOptional, serverEnv, serverFeatures } from "@partybooth/env/server";

import type { PushAdapter, PushAdapterDescription } from "./adapter";
import { PushNotConfiguredError } from "./adapter";
import { createExpoPushAdapter } from "./expo";

/**
 * One place decides what "send a push" means on this deployment.
 *
 * `EAS_PROJECT_ID` is the gate (`serverFeatures.expoPush`) because a push token
 * belongs to an Expo project and a deployment that does not know which project
 * it is cannot meaningfully send anything. `EXPO_ACCESS_TOKEN` is optional and
 * only switches on enhanced push security — the Expo docs treat it that way and
 * so does this.
 *
 * With neither set — which is every deployment by default, and every CI run —
 * the unconfigured adapter is returned and the dispatcher marks its
 * notifications `dropped`. Nothing throws on a request path, because a party
 * where nobody's phone buzzes is a party.
 */
export function resolvePushAdapter(): PushAdapter {
  const override = currentOverride();
  if (override !== undefined) return override();
  if (!serverFeatures.expoPush) return unconfiguredPushAdapter();
  const accessToken = envOptional(serverEnv, "EXPO_ACCESS_TOKEN");
  return createExpoPushAdapter(accessToken === undefined ? {} : { accessToken });
}

export function unconfiguredPushAdapter(): PushAdapter {
  const description: PushAdapterDescription = {
    provider: "unconfigured",
    configured: false,
    authenticated: false,
  };
  // A rejected promise rather than a synchronous throw, for the same reason the
  // storage seam does it: the interface is async, and an implementation that
  // throws before returning one is a different failure mode from the one every
  // caller is written against.
  const fail = <T>(): Promise<T> => Promise.reject(new PushNotConfiguredError());

  return {
    provider: "unconfigured",
    configured: false,
    sendChunk: () => fail(),
    getReceipts: () => fail(),
    describe: () => ({ ...description }),
  };
}

/* -------------------------------------------------------------------------- */
/* Test seam                                                                  */
/* -------------------------------------------------------------------------- */

type PushAdapterFactory = () => PushAdapter;

/**
 * Point every push call at a different implementation for the duration of a
 * test.
 *
 * On `globalThis` rather than a module-level `let`, and that is not paranoia —
 * it is the lesson the storage seam already paid for. `convex-test` loads
 * queries and mutations through the `import.meta.glob` map in
 * `testing.helpers.ts` but evaluates **actions** in their own module graph, and
 * the push dispatcher is an action. A module-level binding set by the suite is
 * simply not the binding the dispatcher reads; the realm is the one thing both
 * graphs share.
 */
const OVERRIDE_KEY = "__partybooth_push_adapter_override__";

interface OverrideHost {
  [OVERRIDE_KEY]?: PushAdapterFactory | undefined;
}

function overrideHost(): OverrideHost {
  return globalThis as unknown as OverrideHost;
}

function currentOverride(): PushAdapterFactory | undefined {
  return overrideHost()[OVERRIDE_KEY];
}

export function setPushAdapterOverride(factory: PushAdapterFactory | undefined): void {
  overrideHost()[OVERRIDE_KEY] = factory;
}

export { PushNotConfiguredError };
export type { PushAdapter, PushAdapterDescription };
