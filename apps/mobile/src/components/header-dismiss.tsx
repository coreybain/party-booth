/**
 * The text button a modally-presented route puts in its header.
 *
 * Native-stack modals get a swipe-down gesture and nothing else — no back
 * button, because there is nothing to go back to, and swiping is
 * undiscoverable enough that iOS's own sheets always pair it with a labelled
 * button. "Cancel" for a sheet you abort (the join flows), "Done" for one you
 * dismiss after reading.
 */

import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";

import { colors, typography } from "../theme";

export function HeaderDismissButton({ label = "Cancel" }: { label?: "Cancel" | "Done" | "Close" }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Closes this sheet."
      hitSlop={12}
      onPress={() => {
        if (router.canGoBack()) router.back();
      }}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { ...typography.heading, color: colors.accent },
  pressed: { opacity: 0.6 },
});
