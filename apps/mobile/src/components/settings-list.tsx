/**
 * iOS-style grouped ("inset") list primitives for the Settings stack.
 *
 * The settings screen used to be one long scroll of cards; it is now a short
 * main page of rows that push subpages, which is what these express. They are
 * deliberately dumb: a section is a rounded surface with hairlines between its
 * rows, a row is a label with an optional value and an optional chevron, and
 * navigation stays in the screens.
 */

import { Ionicons } from "@expo/vector-icons";
import { Children, Fragment } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, typography } from "../theme";

import type { ComponentProps, ReactNode } from "react";

type IconName = ComponentProps<typeof Ionicons>["name"];

/**
 * A grouped section: optional uppercase header, a rounded card of rows with
 * hairline separators, optional muted footer for the sentence of explanation
 * iOS puts under a group.
 */
export function ListSection({
  header,
  footer,
  children,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
}) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.section}>
      {header ? <Text style={styles.sectionHeader}>{header}</Text> : null}
      <View style={styles.group}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.sectionFooter}>{footer}</Text> : null}
    </View>
  );
}

/**
 * One row. With `onPress` it renders a disclosure chevron (suppress it with
 * `chevron={false}` for rows that act rather than navigate — opening a browser,
 * signing out). `value` is the muted right-hand detail, e.g. the active party's
 * name on the Party row.
 */
export function ListRow({
  label,
  value,
  icon,
  onPress,
  chevron = onPress !== undefined,
  tone = "default",
  centered = false,
  disabled = false,
  busy = false,
  accessory,
  accessibilityHint,
}: {
  label: string;
  value?: string;
  icon?: IconName;
  onPress?: () => void;
  chevron?: boolean;
  tone?: "default" | "danger";
  /** Centered label with no value/chevron — the iOS "Sign Out" row shape. */
  centered?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Replaces the value/chevron area, e.g. a `Switch`. */
  accessory?: ReactNode;
  accessibilityHint?: string;
}) {
  const labelColor = tone === "danger" ? colors.danger : colors.text;
  const interactive = onPress !== undefined && !disabled && !busy;

  const body = centered ? (
    busy ? (
      <ActivityIndicator color={labelColor} size="small" />
    ) : (
      <Text style={[styles.label, styles.labelCentered, { color: labelColor }]}>{label}</Text>
    )
  ) : (
    <>
      {icon ? (
        <View style={styles.icon}>
          <Ionicons name={icon} size={18} color={tone === "danger" ? colors.danger : colors.accent} />
        </View>
      ) : null}
      <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
        {label}
      </Text>
      {accessory ?? (
        <>
          {value ? (
            <Text style={styles.value} numberOfLines={1}>
              {value}
            </Text>
          ) : null}
          {busy ? (
            <ActivityIndicator color={colors.textFaint} size="small" />
          ) : chevron ? (
            <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
          ) : null}
        </>
      )}
    </>
  );

  if (onPress === undefined) {
    return <View style={styles.row}>{body}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !interactive, busy }}
      accessibilityHint={accessibilityHint}
      disabled={!interactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.xs },
  sectionHeader: {
    ...typography.label,
    color: colors.textMuted,
    textTransform: "uppercase",
    paddingHorizontal: spacing.md,
  },
  sectionFooter: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 17,
    paddingHorizontal: spacing.md,
  },
  group: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.lg,
  },
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surfaceRaised },
  rowDisabled: { opacity: 0.45 },
  icon: { width: 24, alignItems: "center" },
  label: { ...typography.body, flexShrink: 1, marginRight: "auto" },
  labelCentered: { ...typography.heading, textAlign: "center" },
  value: { ...typography.body, color: colors.textMuted, flexShrink: 1, maxWidth: "50%" },
});
