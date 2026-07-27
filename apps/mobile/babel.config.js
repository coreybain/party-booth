/**
 * Metro/Babel transform for apps/mobile.
 *
 * `babel-preset-expo` already wires JSX, TypeScript, the Expo Router entry, and the
 * `EXPO_PUBLIC_*` inlining pass. `react-native-worklets/plugin` must stay LAST — it is
 * the Reanimated 4 worklet transform (renamed from `react-native-reanimated/plugin`).
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { reanimated: false }]],
    plugins: ["react-native-worklets/plugin"],
  };
};
