/**
 * The six-digit join-code field.
 *
 * One real `TextInput` stretched invisibly across six boxes, rather than six inputs
 * wired together. Six inputs means six focus states, backspace-across-boundaries
 * handling, and a paste that only fills the first box — all of which are bugs waiting
 * for a guest standing in a hallway. One input keeps the platform's own selection,
 * paste and delete behaviour and lets the boxes be purely decorative.
 *
 * No validation happens here: `readCodeInput` in `src/lib/join.ts` owns that, which in
 * turn defers the *shape* of a code to `@partybooth/contracts/codes` — the same
 * function Convex validates with. This component only renders what it is given.
 */

import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRef } from "react";

import { JOIN_CODE_LENGTH } from "../lib/join";
import { colors, radius, spacing, typography } from "../theme";

export function CodeField({
  value,
  onChangeText,
  onSubmit,
  editable = true,
  autoFocus = false,
  invalid = false,
}: {
  value: string;
  onChangeText: (next: string) => void;
  onSubmit?: () => void;
  editable?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const inputRef = useRef<TextInput>(null);
  const slots = Array.from({ length: JOIN_CODE_LENGTH }, (_, index) => value[index] ?? "");
  // The caret sits on the first empty box, or on the last one when the code is full.
  const caretIndex = Math.min(value.length, JOIN_CODE_LENGTH - 1);

  return (
    <Pressable
      // Not itself an accessibility target: the real `TextInput` below is, and a
      // wrapper that claims focus would hide the field's label from the screen reader.
      accessible={false}
      onPress={() => inputRef.current?.focus()}
      style={styles.wrapper}
    >
      <View style={styles.slots} pointerEvents="none">
        {slots.map((digit, index) => (
          <View
            key={index}
            style={[
              styles.slot,
              invalid && styles.slotInvalid,
              editable &&
                index === caretIndex &&
                value.length < JOIN_CODE_LENGTH &&
                styles.slotActive,
            ]}
          >
            <Text style={styles.slotText}>{digit}</Text>
          </View>
        ))}
      </View>

      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        editable={editable}
        autoFocus={autoFocus}
        // `number-pad` rather than `numeric`: no decimal point to mistype, and the
        // large keys are the difference between one attempt and three in a dark room.
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={JOIN_CODE_LENGTH}
        returnKeyType="go"
        // Nothing here should be remembered, suggested or capitalised.
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        accessibilityLabel="Six-digit join code"
        accessibilityHint="Type the code printed under the QR sign."
        // Transparent and stretched over the boxes so the platform's own caret,
        // selection and paste menu all still work.
        style={styles.input}
        caretHidden
        selectionColor="transparent"
      />
    </Pressable>
  );
}

const SLOT_HEIGHT = 60;

const styles = StyleSheet.create({
  wrapper: { position: "relative", justifyContent: "center" },
  slots: { flexDirection: "row", gap: spacing.sm },
  slot: {
    flex: 1,
    height: SLOT_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  slotActive: { borderColor: colors.accent },
  slotInvalid: { borderColor: colors.danger },
  slotText: { ...typography.display, color: colors.text },
  input: {
    // Written out rather than spread from `StyleSheet.absoluteFill`, which is a
    // registered style *id* (a number) and cannot be spread into an object.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: SLOT_HEIGHT,
    // Never visible: the boxes above render the digits. Kept at full size so it stays
    // focusable and hit-testable on both platforms — a zero-sized input is neither.
    color: "transparent",
    opacity: 0,
    fontSize: 1,
  },
});
