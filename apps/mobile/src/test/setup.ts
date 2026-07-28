/**
 * Setup for the `mobile-screens` Vitest project.
 *
 * Only the things every screen test needs regardless of what it is testing:
 * the two globals React Native's runtime supplies and the DOM does not, and a
 * teardown so one test's tree cannot be found by the next one's query.
 *
 * Module mocks are deliberately **not** here. They are declared in each test
 * file, where you can see what is faked next to the assertion that depends on
 * it — a screen test whose fakes live in another file is a test that quietly
 * stops meaning what it says.
 */

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// `react-native` already declares `__DEV__` as a global constant, so it cannot
// be re-declared — but under jsdom nothing has *assigned* it, and anything
// reading it (the dev-only role preview, RNW's own warnings) throws a
// ReferenceError on first render. Defined rather than declared.
Object.defineProperty(globalThis, "__DEV__", { value: true, configurable: true });

// `react-native-web` asks for this on first render (Appearance, useColorScheme).
// jsdom has no implementation, and the failure is an unhelpful TypeError deep
// inside a StyleSheet call rather than anything to do with the test.
if (typeof window !== "undefined" && window.matchMedia === undefined) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
