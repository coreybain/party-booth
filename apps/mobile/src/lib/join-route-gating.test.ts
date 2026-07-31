import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The join routes must not touch a Convex hook above the configuration gate.
 *
 * This is a source-shape test, which is unusual, and it is here because the bug it
 * guards against is invisible to every other kind of test this app has:
 *
 *   - `AppProviders` (`src/providers/index.tsx`) mounts **no** `ConvexProvider` when
 *     `EXPO_PUBLIC_CONVEX_URL` is absent — that is what lets the app boot with zero
 *     credentials, and it is deliberate.
 *   - A universal link opens `/join/<token>` **directly**, without ever passing
 *     `app/index.tsx` and its `SetupRequired` screen.
 *   - `useQuery` / `useMutation` under no provider throw "Could not find Convex
 *     client", so the first thing a guest scanning a QR on an unconfigured build sees
 *     is a crash — and `expo export` still passes, because the module imports fine.
 *
 * Rendering React Native components under Vitest needs a Metro-equivalent transform
 * pipeline (Flow types in react-native's own source, native module mocks), which
 * `vitest.config.ts` explicitly declines. So the invariant is checked where it can be:
 * in the ordering of the file. The gate has to come first.
 */

const ROUTES = {
  "app/join/[token].tsx": "../../app/join/[token].tsx",
  "app/join/index.tsx": "../../app/join/index.tsx",
} as const;

/** Call sites only — the import statements name these without a paren. */
const CONVEX_HOOKS = ["useQuery(", "useMutation(", "useJoinEvent("] as const;

const GATE = 'appConfig.status === "unconfigured"';

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe.each(Object.entries(ROUTES))("%s", (name, relative) => {
  const source = sourceOf(relative);

  it("gates on the configuration before anything Convex-shaped", () => {
    const gate = source.indexOf(GATE);
    expect(gate, `${name} has no configuration gate`).toBeGreaterThanOrEqual(0);

    for (const hook of CONVEX_HOOKS) {
      const used = source.indexOf(hook);
      if (used === -1) continue;
      expect(used, `${name} calls ${hook} before the configuration gate`).toBeGreaterThan(gate);
    }
  });

  it("renders the setup screen rather than a blank one", () => {
    expect(source).toContain("SetupRequired");
  });

  it("sends an un-onboarded guest through the name step before joining", () => {
    // PLAN.md: "Apple or Google sign-in, **then** name + photo confirmation". A guest
    // who joins before that lands in the host's moderation queue as "j.smith82".
    expect(source).toContain("needsOnboarding");
    expect(source).toContain("needsTermsAcceptance");
    expect(source).toContain('href="/onboarding"');
    // …and the invite is parked, so the detour does not lose the party.
    expect(source).toContain("rememberPendingInvite");
  });
});
