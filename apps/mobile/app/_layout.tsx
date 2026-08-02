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
const sentryEnabled = initSentry({
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
          {/* The event switcher. A modal rather than a tab: it is a decision you make
              and dismiss, not a place you spend time, and a fifth tab would push the
              Host tab off the comfortable reach of a thumb. */}
          <Stack.Screen name="events" options={{ title: "Your parties", presentation: "modal" }} />
          {/* Both join doors are modals over whatever the guest was doing, because a
              universal link can land on any screen and must not destroy its state. */}
          <Stack.Screen
            name="join/index"
            options={{ title: "Join a party", presentation: "modal" }}
          />
          <Stack.Screen
            name="join/scan"
            options={{ title: "Scan a QR code", presentation: "modal" }}
          />
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

// `Sentry.wrap` installs the error boundary and touch/navigation instrumentation. The
// SDK warns when it is wrapped before `Sentry.init`, so an intentionally unconfigured
// checkout exports the ordinary layout instead.
export default sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout;
