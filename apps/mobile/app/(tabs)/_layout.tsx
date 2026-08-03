import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";

import { canAccessHostTools } from "@/lib/roles";
import { useSession } from "@/providers/session";
import { colors } from "@/theme";

import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";

type IconName = ComponentProps<typeof Ionicons>["name"];

/** Small helper so each `tabBarIcon` stays a one-liner. */
function icon(name: IconName) {
  return ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const { state, roles } = useSession();

  // Deep links and restored tab state can bypass the entry route. Keep the
  // content-creation shell behind the same profile/terms gate as `/` and join.
  if (state.status === "signed-in" && (state.needsOnboarding || state.needsTermsAcceptance)) {
    return <Redirect href="/onboarding" />;
  }

  // The Host tab is conditional, not merely disabled: a guest should never see that
  // host tools exist. `href: null` removes the button while leaving `/host` reachable
  // by direct navigation — the screen itself re-checks the role (see host.tsx).
  //
  // `roles.eventRole` is now the caller's real membership role for the **active**
  // event, so switching parties in Settings can add or remove this tab. That is
  // correct: a co-host at one party is a plain guest at another. It also means an
  // account matched to a co-host invitation by verified email gets the tab as soon as
  // `users.refreshRoles` lands, with no sign-out in between.
  const showHostTab = canAccessHostTools(roles);

  return (
    <Tabs
      screenOptions={{
        // Party switching lives in Settings. The other tabs keep their full vertical
        // space and name the active party only where that context is useful.
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="camera"
        options={{ title: "Camera", tabBarIcon: icon("camera-outline") }}
      />
      <Tabs.Screen
        name="photos"
        options={{ title: "Photos", tabBarIcon: icon("images-outline") }}
      />
      <Tabs.Screen
        name="host"
        options={{
          title: "Host",
          tabBarIcon: icon("sparkles-outline"),
          href: showHostTab ? "/host" : null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: icon("settings-outline") }}
      />
    </Tabs>
  );
}
