/**
 * Shared presentational primitives.
 *
 * Deliberately small and dependency-free: every screen in Sprint 1 is a shell, and a
 * handful of consistent primitives beats a component library we would have to learn.
 */

import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, radius, spacing, typography } from "../theme";

import type { ComponentProps, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

type IconName = ComponentProps<typeof Ionicons>["name"];

export function Screen({
  children,
  style,
  edges = ["top", "left", "right"],
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  edges?: ComponentProps<typeof SafeAreaView>["edges"];
}) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      <View style={[styles.screenInner, style]}>{children}</View>
    </SafeAreaView>
  );
}

export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>{title}</Text>
      {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * Empty state. `icon` + one sentence of what will appear here + optional action.
 * Used for every Sprint-1 placeholder so the app reads as unfinished-but-intentional
 * rather than broken.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={28} color={colors.accent} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "danger";

export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  disabled = false,
  busy = false,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const isDisabled = disabled || busy;
  const tint =
    variant === "primary" ? colors.onAccent : variant === "danger" ? colors.danger : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      // Explicit rather than inferred from the `<Text>` child, because while
      // `busy` the child is a spinner and the button would otherwise have no
      // accessible name at all — exactly when a screen reader user most needs
      // to know which button they are waiting on.
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy }}
      accessibilityHint={accessibilityHint}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        pressed && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={tint} size="small" />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={tint} /> : null}
          <Text style={[styles.buttonLabel, { color: tint }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export type NoticeTone = "info" | "warning" | "danger" | "success";

const NOTICE_TONES: Record<NoticeTone, { border: string; icon: IconName }> = {
  info: { border: colors.accentSoft, icon: "information-circle-outline" },
  warning: { border: colors.warning, icon: "alert-circle-outline" },
  danger: { border: colors.danger, icon: "close-circle-outline" },
  success: { border: colors.success, icon: "checkmark-circle-outline" },
};

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
}) {
  const { border, icon } = NOTICE_TONES[tone];
  return (
    <View style={[styles.notice, { borderLeftColor: border }]}>
      <View style={styles.noticeHeader}>
        <Ionicons name={icon} size={16} color={border} />
        <Text style={styles.noticeTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/** Small uppercase label, e.g. "SPRINT 3" or "PENDING". */
export function Badge({ label, tone = colors.accentSoft }: { label: string; tone?: string }) {
  return (
    <View style={[styles.badge, { borderColor: tone }]}>
      <Text style={[styles.badgeLabel, { color: tone }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function BodyText({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function MutedText({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function MonoText({ children }: { children: ReactNode }) {
  return <Text style={styles.mono}>{children}</Text>;
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} />
      {label ? <Text style={styles.muted}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenInner: { flex: 1, paddingHorizontal: spacing.lg },
  header: { paddingTop: spacing.lg, paddingBottom: spacing.lg, gap: spacing.xs },
  headerTitle: { ...typography.display, color: colors.text },
  headerSubtitle: { ...typography.body, color: colors.textMuted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  empty: { alignItems: "center", gap: spacing.md, paddingVertical: spacing.xxl },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  emptyTitle: { ...typography.heading, color: colors.text, textAlign: "center" },
  emptyBody: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    maxWidth: 320,
    lineHeight: 21,
  },
  emptyAction: { paddingTop: spacing.sm },
  button: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  buttonDanger: { backgroundColor: "transparent", borderColor: colors.danger },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { ...typography.heading },
  notice: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    padding: spacing.md,
    gap: spacing.sm,
  },
  noticeHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  noticeTitle: { ...typography.label, color: colors.text, flexShrink: 1 },
  badge: {
    alignSelf: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeLabel: { ...typography.caption, fontWeight: "700", letterSpacing: 0.6 },
  body: { ...typography.body, color: colors.text, lineHeight: 21 },
  muted: { ...typography.body, color: colors.textMuted, lineHeight: 21 },
  mono: { ...typography.mono, color: colors.textMuted },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
});
