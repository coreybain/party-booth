import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

import { EventHeader } from "@/components/event-header";
import { canAccessHostTools } from "@/lib/roles";
import { useRoles } from "@/providers/session";
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
  const roles = useRoles();

  // The Host tab is conditional, not merely disabled: a guest should never see that
  // host tools exist. `href: null` removes the button while leaving `/host` reachable
  // by direct navigation — the screen itself re-checks the role (see host.tsx).
  //
  // `roles.eventRole` is now the caller's real membership role for the **active**
  // event, so switching parties in the header can add or remove this tab. That is
  // correct: a co-host at one party is a plain guest at another. It also means an
  // account matched to a co-host invitation by verified email gets the tab as soon as
  // `users.refreshRoles` lands, with no sign-out in between.
  const showHostTab = canAccessHostTools(roles);

  return (
    <Tabs
      screenOptions={{
        // One header for every tab, so the active party is named in exactly one place
        // and no screen can render a stale one. Tab screens therefore drop the `top`
        // safe-area edge — this header owns the notch.
        header: () => <EventHeader />,
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
