import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests for apps/mobile, in two projects.
 *
 * ## `logic` — plain Node, no React
 *
 * Everything a durable queue can get wrong (a transition that should not be
 * legal, a backoff that resets, a row written by an older build) is decided in a
 * function that takes `now` as an argument and touches no Expo module. Those
 * live in `src/lib` and `src/upload` and run in Node with nothing mocked, which
 * is why they can be trusted without a device in the room.
 *
 * ## `screens` — jsdom, with `react-native` aliased to `react-native-web`
 *
 * Sprint 3's expensive lesson was that "built and unit-tested" is not the same
 * as "mounted": `use-capture`, `camera-controls` and `undo-pill` were all green
 * while being imported by nothing at all, and no test in this package could
 * possibly have noticed. These tests exist to notice.
 *
 * Rendering the real `react-native` package here is not practical — its source
 * is Flow-typed and needs a Metro-equivalent transform. `react-native-web` is
 * the *same component API* compiled to DOM elements, and it is already a
 * dependency because `expo export --platform all` builds a web bundle with it.
 * So the screens under test are the real screens, the layout primitives are
 * real, and only the native leaves are mocked (see `src/test/`).
 *
 * That boundary is deliberate: it catches "the screen renders no `CameraView`",
 * "the shutter is not wired to `capture`" and "the library button is not gated
 * on the event flag" — which is exactly the class of defect that shipped — and
 * it does not pretend to catch anything that needs a real camera. The
 * physical-device passes in Sprint 6 are still what prove the picture is sharp.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
        },
        test: {
          name: "mobile",
          environment: "node",
          include: ["src/lib/**/*.test.ts", "src/upload/**/*.test.ts"],
        },
      },
      {
        // `oxc` rather than `esbuild`: Vite 8 transforms with Rolldown/oxc, and
        // `tsconfig.json` sets `jsx: "preserve"` for Metro — which Vite would
        // otherwise honour and fail to parse.
        oxc: { jsx: { runtime: "automatic", importSource: "react" } },
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            // The whole trick. Anything importing `react-native` — the screens,
            // `components/ui`, `camera-controls`, `undo-pill` — gets the DOM
            // implementation of the same API.
            "react-native": "react-native-web",
          },
        },
        test: {
          name: "mobile-screens",
          environment: "jsdom",
          include: ["app/**/*.test.tsx", "src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
