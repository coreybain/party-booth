import { Stack } from "expo-router";

import { colors } from "@/theme";

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        // Onboarding follows sign-in; a swipe back to the sign-in screen while already
        // authenticated would be a dead end.
        gestureEnabled: false,
      }}
    >
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="onboarding" />
    </Stack>
  );
}
