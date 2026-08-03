import { Stack } from "expo-router";

import { colors } from "@/theme";

/**
 * Settings is a navigation stack, not a scroll.
 *
 * The main page is a short list of rows; everything with its own weight —
 * parties, notifications, blocked people, verified emails, account data —
 * pushes a subpage with a native header and a back button, which is the shape
 * an iOS settings screen is expected to have. The three things App Review
 * checks for (account deletion, blocked users, the privacy policy) each stay
 * one obvious tap from the main page: `docs/store/ios-submission.md`.
 */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text },
        headerLargeTitleStyle: { color: colors.text },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Settings", headerLargeTitle: true }} />
      <Stack.Screen name="parties" options={{ title: "Parties" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="blocked" options={{ title: "Blocked People" }} />
      <Stack.Screen name="emails" options={{ title: "Verified Emails" }} />
      <Stack.Screen name="account" options={{ title: "Account Data" }} />
      <Stack.Screen name="about" options={{ title: "About" }} />
    </Stack>
  );
}
