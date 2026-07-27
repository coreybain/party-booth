import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { appConfig } from "@/env";
import { initSentry, Sentry } from "@/lib/sentry";
import { AppProviders } from "@/providers";
import { colors } from "@/theme";

/**
 * Sentry starts before React does so that errors thrown during the first render are
 * captured. It is a no-op when `EXPO_PUBLIC_SENTRY_DSN` is unset, which is the normal
 * state of a fresh checkout.
 */
initSentry({
  dsn: appConfig.status === "ready" ? appConfig.sentryDsn : undefined,
});

function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProviders>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { color: colors.text },
            contentStyle: { backgroundColor: colors.bg },
            headerShadowVisible: false,
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="join/[token]"
            options={{ title: "Join event", presentation: "modal" }}
          />
          <Stack.Screen name="+not-found" options={{ title: "Not found" }} />
        </Stack>
      </AppProviders>
    </SafeAreaProvider>
  );
}

// `Sentry.wrap` installs the error boundary and touch/navigation instrumentation. It is
// safe to apply even when `Sentry.init` was never called.
export default Sentry.wrap(RootLayout);
