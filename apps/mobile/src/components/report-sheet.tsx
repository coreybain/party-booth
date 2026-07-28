/**
 * Reporting content, and blocking the person who posted it.
 *
 * These are **App Store Review Guideline 1.2** requirements, not features: an app
 * with user-generated content must offer "a mechanism to report offensive content
 * and timely responses to concerns" and "the ability to block abusive users". A
 * build without both is rejected, and the rejection costs a review cycle we do
 * not have before 5 August.
 *
 * They are also two genuinely different promises, and the UI has to keep them
 * apart because the backend does:
 *
 * - **Report** flags the item for the *host*. It moderates nothing. Auto-hiding
 *   on report would hand any guest a veto over any other guest's photograph, at a
 *   party where everybody can see everybody — which is a worse abuse vector than
 *   the one it closes. The copy says "the host" out loud so nobody expects the
 *   photo to vanish.
 * - **Block** is a filter on *your own* reads. Per-account, global across
 *   parties, silent, and it touches no membership: `blocks.block` changes nothing
 *   for anybody else and the blocked person is never told. Blocking is not
 *   ejecting, and the copy says that too.
 *
 * Both are idempotent on the server (`report` per `(media, reporter)`, `block`
 * per `(blocker, blocked)`), so a double tap on party wifi is safe and the second
 * one answers `created: false` rather than erroring.
 *
 * The reporter's identity is never returned to a host. That is enforced in
 * Convex; it is repeated in the confirmation copy here because it is the thing a
 * guest actually wants to know before they tap.
 */

import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { REPORT_REASON_PROMPTS } from "@partybooth/contracts/copy";
import { REPORT_REASONS, type ReportReason } from "@partybooth/contracts/media";

import { Badge, Button, MutedText, Notice } from "./ui";
import { colors, radius, spacing, typography } from "../theme";

/* -------------------------------------------------------------------------- */
/* Copy                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What each reason means, in a guest's words.
 *
 * Hoisted into `@partybooth/contracts/copy` in Sprint 4, alongside the host's
 * flatter register for the same enum. The two registers are still two maps —
 * a guest choosing from a list and a host triaging a queue want different
 * sentences — but they now sit next to each other, so the difference is visible
 * and intentional rather than two files that drift.
 */
const REASON_COPY = REPORT_REASON_PROMPTS;

const SUBMITTING_FAILED = "That report didn't send. Check your connection and try again.";

/* -------------------------------------------------------------------------- */
/* Report sheet                                                               */
/* -------------------------------------------------------------------------- */

export interface ReportTarget {
  readonly mediaId: string;
  /** Whose item it is — needed for the block offer after a report. */
  readonly uploaderUserId: string;
  readonly uploaderDisplayName: string;
  readonly isOwn: boolean;
}

export type ReportSubmit = (input: {
  mediaId: string;
  reason: ReportReason;
  details?: string;
}) => Promise<void>;

export type BlockSubmit = (userId: string) => Promise<void>;

/**
 * Pick a reason, add a sentence, send.
 *
 * Deliberately three screens' worth of decision compressed into one: choose,
 * confirm, done. A guest reporting something at a party is embarrassed and in a
 * hurry, and every extra step is a report that does not get made.
 */
export function ReportSheet({
  target,
  onReport,
  onBlock,
  onClose,
}: {
  /** `null` closes the sheet. */
  target: ReportTarget | null;
  onReport: ReportSubmit;
  /** `null` in a build with no backend, where blocking cannot be performed. */
  onBlock: BlockSubmit | null;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={target !== null}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {target === null ? null : (
            <ReportBody
              key={target.mediaId}
              target={target}
              onReport={onReport}
              onBlock={onBlock}
              onClose={onClose}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * The sheet's contents, remounted per target.
 *
 * `key={target.mediaId}` on the caller is what resets the chosen reason and the
 * typed detail between two reports. Without it a guest who backs out of one
 * report and opens another finds the first one's reason still selected — which
 * at best is confusing and at worst files the wrong complaint.
 */
function ReportBody({
  target,
  onReport,
  onBlock,
  onClose,
}: {
  target: ReportTarget;
  onReport: ReportSubmit;
  onBlock: BlockSubmit | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const submit = useCallback(async () => {
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = details.trim();
      await onReport({
        mediaId: target.mediaId,
        reason,
        ...(trimmed.length === 0 ? {} : { details: trimmed }),
      });
      setSent(true);
    } catch {
      setError(SUBMITTING_FAILED);
    } finally {
      setBusy(false);
    }
  }, [reason, details, onReport, target.mediaId]);

  const block = useCallback(async () => {
    if (onBlock === null) return;
    setBusy(true);
    setError(null);
    try {
      await onBlock(target.uploaderUserId);
      setBlocked(true);
    } catch {
      setError("That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [onBlock, target.uploaderUserId]);

  /* ---- After sending -------------------------------------------------- */

  if (sent) {
    return (
      <View style={styles.body}>
        <SheetHeader title="Thanks — the host has been told" onClose={onClose} />
        <Notice tone="success" title="Reported">
          <MutedText>
            The host of this party can now see it flagged, with what you said. They decide what
            happens to it — we do not tell them who reported it.
          </MutedText>
        </Notice>

        {/* Offered here rather than buried in a menu: the moment somebody has
            just reported a person is the moment "and stop showing me their
            photos" is the obvious next thought. */}
        {!target.isOwn && onBlock !== null ? (
          blocked ? (
            <Notice tone="info" title={`You've blocked ${target.uploaderDisplayName}`}>
              <MutedText>
                Their photos and videos are hidden from you everywhere in PartyBooth. They are not
                told, and they stay in the party. You can undo this in Settings.
              </MutedText>
            </Notice>
          ) : (
            <>
              <MutedText>
                Would you also like to stop seeing anything from {target.uploaderDisplayName}?
              </MutedText>
              <Button
                label={`Block ${target.uploaderDisplayName}`}
                variant="secondary"
                icon="person-remove-outline"
                busy={busy}
                onPress={() => void block()}
              />
            </>
          )
        ) : null}

        {error !== null ? (
          <Notice tone="danger" title="That didn't work">
            <MutedText>{error}</MutedText>
          </Notice>
        ) : null}

        <Button label="Done" onPress={onClose} />
      </View>
    );
  }

  /* ---- Choosing ------------------------------------------------------- */

  return (
    <View style={styles.body}>
      <SheetHeader title="Report this to the host" onClose={onClose} />

      <MutedText>
        The host of this party reviews it and decides. Reporting does not remove anything on its
        own, and nobody is told who reported it.
      </MutedText>

      <ScrollView style={styles.reasons} keyboardShouldPersistTaps="handled">
        {REPORT_REASONS.map((value) => {
          const copy = REASON_COPY[value];
          const selected = reason === value;
          return (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={copy.label}
              accessibilityHint={copy.detail}
              onPress={() => setReason(value)}
              style={[styles.reason, selected && styles.reasonSelected]}
            >
              <Ionicons
                name={selected ? "radio-button-on" : "radio-button-off"}
                size={20}
                color={selected ? colors.accent : colors.textFaint}
              />
              <View style={styles.reasonCopy}>
                <Text style={styles.reasonLabel}>{copy.label}</Text>
                <Text style={styles.reasonDetail}>{copy.detail}</Text>
              </View>
            </Pressable>
          );
        })}

        <TextInput
          style={styles.input}
          value={details}
          onChangeText={setDetails}
          placeholder="Anything else the host should know (optional)"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Anything else the host should know"
          multiline
          // Long enough for a real sentence, short enough that the host's queue
          // stays readable. The server caps it too.
          maxLength={500}
        />
      </ScrollView>

      {error !== null ? (
        <Notice tone="danger" title="That didn't work">
          <MutedText>{error}</MutedText>
        </Notice>
      ) : null}

      <Button
        label="Send report"
        icon="flag-outline"
        disabled={reason === null}
        busy={busy}
        onPress={() => void submit()}
      />
    </View>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        hitSlop={12}
        style={styles.headerClose}
      >
        <Ionicons name="close" size={20} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The item menu                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The long-press menu on a gallery item.
 *
 * Long-press *and* an explicit button, because a long-press is undiscoverable
 * and an App Review reviewer with a checklist has ninety seconds to find the
 * reporting mechanism. The button is small and in the corner; the long-press is
 * what a guest will actually use.
 *
 * Never offered on your own item: reporting yourself to yourself is noise, and
 * "Take it back" in My media is the real control for that.
 */
export function ItemActionsMenu({
  target,
  onReport,
  onBlock,
  onClose,
}: {
  target: ReportTarget | null;
  onReport: () => void;
  onBlock: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={target !== null}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close the menu">
        <View style={styles.menu}>
          {target === null ? null : (
            <>
              <View style={styles.menuHeader}>
                <Badge label="from" />
                <Text style={styles.menuName}>{target.uploaderDisplayName}</Text>
              </View>
              <Button
                label="Report to the host"
                variant="secondary"
                icon="flag-outline"
                onPress={onReport}
              />
              {onBlock === null ? null : (
                <Button
                  label={`Block ${target.uploaderDisplayName}`}
                  variant="secondary"
                  icon="person-remove-outline"
                  accessibilityHint="Hides everything they post, everywhere, only for you. They are not told."
                  onPress={onBlock}
                />
              )}
              <Button label="Cancel" variant="secondary" icon="close-outline" onPress={onClose} />
            </>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(6, 3, 10, 0.7)",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    maxHeight: "88%",
  },
  body: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  title: { ...typography.title, color: colors.text, flex: 1 },
  headerClose: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
  },
  reasons: { flexGrow: 0 },
  reason: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    // Pressed one-handed, at night, by someone holding a drink.
    minHeight: 56,
  },
  reasonSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  reasonCopy: { flex: 1, gap: 2 },
  reasonLabel: { ...typography.heading, color: colors.text },
  reasonDetail: { ...typography.caption, color: colors.textMuted },
  input: {
    minHeight: 80,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    ...typography.body,
    textAlignVertical: "top",
  },
  menu: {
    margin: spacing.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  menuName: { ...typography.heading, color: colors.text, flexShrink: 1 },
});
