/**
 * PartyBooth design tokens.
 *
 * The app is dark-only (`userInterfaceStyle: "dark"` in app.config.ts): it is used in
 * dim rooms, next to a camera viewfinder, and a single palette removes a whole class of
 * contrast bugs from a one-week build.
 */

export const colors = {
  /** App background. */
  bg: "#12091B",
  /** Cards and sheets. */
  surface: "#1D1029",
  /** Pressed / elevated surfaces. */
  surfaceRaised: "#2A1839",
  border: "#3A2350",

  text: "#FFF4F9",
  textMuted: "#B9A3C9",
  textFaint: "#7C6690",

  /** Primary brand accent — actions, active tab, focus. */
  accent: "#FF2E88",
  accentPressed: "#D91F70",
  accentSoft: "#7C3AED",
  onAccent: "#12091B",

  danger: "#FF5C5C",
  success: "#3DDC97",
  warning: "#FFB020",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 30, fontWeight: "700", letterSpacing: -0.5 },
  title: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 15, fontWeight: "400" },
  label: { fontSize: 13, fontWeight: "600", letterSpacing: 0.2 },
  caption: { fontSize: 12, fontWeight: "400" },
  mono: { fontSize: 13, fontFamily: "Menlo" },
} as const;

export type Colors = typeof colors;
