/**
 * Host tab — the party, from behind the counter.
 *
 * Sprint 2 shipped the *shell* of this: the tab appeared for the right people
 * and named the party its tools would act on. Everything under it was a
 * scaffold. This is Sprint 5's replacement, and it is deliberately the four
 * things a host does while standing in a room full of people, in the order they
 * do them:
 *
 * 1. **Let people in** — the six-digit code and the QR, big enough to hold up.
 * 2. **Take the invite back** — rotation, with the keep-or-revoke choice made
 *    explicitly rather than implied by a button label.
 * 3. **Run the party** — open early, pause when the queue outruns you, push the
 *    finish time out, end it.
 * 4. **Clear the queue** — approve and decline, one tap each, flagged first.
 *
 * ## Two rules this screen is built around
 *
 * **The role check is repeated here even though the tab is hidden.** `href:
 * null` in `(tabs)/_layout.tsx` removes the *button*; the route stays reachable
 * by `router.push` and by a notification tap. A screen that treats navigation as
 * its gate is a screen that leaks host tools to guests.
 *
 * **Nothing is optimistic.** Every control offered is one the contract says
 * would change something, computed from the same `hostAbilities` the tab uses,
 * against this party's real state — and the answer from Convex is reported
 * verbatim, including a partial refusal. `apps/web`'s moderation grid made the
 * same choice for the same reason: at a party, a button that lies is worse than
 * a button that is missing.
 *
 * ## Convex hooks live below the configuration gate
 *
 * An unconfigured build mounts no `ConvexProvider`, and `useQuery` under no
 * provider throws during render. Every Convex call is therefore inside
 * `<HostTools>`, which is only reached once the config is ready and an active
 * event exists — the same shape `(tabs)/photos.tsx` uses.
 */

import {
  keepExistingMemberships,
  ROTATION_CONSEQUENCES,
  type RotationChoice,
} from "@partybooth/contracts/codes";
import { REPORT_REASON_LABELS } from "@partybooth/contracts/copy";
import { SIGNED_HOST_REVIEW_URL_TTL_SECONDS } from "@partybooth/contracts/storage";
import { useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";

import { QrCode } from "@/components/qr-code";
import {
  Badge,
  BodyText,
  Button,
  Card,
  EmptyState,
  Loading,
  MonoText,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { appConfig } from "@/env";
import { useNow } from "@/hooks/use-now";
import { useSignedUrlRefreshKey } from "@/hooks/use-signed-url-refresh";
import { api, type EventSummary, type FlaggedItem, type MediaItem } from "@/lib/api";
import { buildJoinUrl } from "@/lib/deep-links";
import { describeError } from "@/lib/errors";
import { describeEventState, describeSchedule } from "@/lib/events";
import { usableMediaUri, usableUploaderAvatarUri } from "@/lib/media-view";
import { canAccessHostTools, hostAbilities, type HostAbilities } from "@/lib/roles";
import { captureHandledError } from "@/lib/sentry";
import { useSession } from "@/providers/session";
import { colors, radius, spacing, typography } from "@/theme";

/** How far one tap on "Give it another hour" pushes the finish time. */
const EXTEND_BY_MS = 60 * 60_000;

/** Nobody reviews four hundred items on a phone. The web console is for that. */
const QUEUE_LIMIT = 40;

export default function HostScreen() {
  const { roles, activeEvent, configured, eventsLoading } = useSession();

  if (!canAccessHostTools(roles)) {
    // Two different situations, and telling them apart matters. A guest needs to
    // know how to *become* a host; a locked host needs to know their account is
    // the problem, and must not be told to ask themselves for access. This is
    // the RC5 demo seen from the phone: lock the organiser from `/admin` and
    // everything freezes, including here.
    const locked = roles.accountLocked === true && roles.eventRole !== null;

    return (
      <Screen>
        <ScreenHeader title="Host" />
        <EmptyState
          icon="lock-closed-outline"
          title={locked ? "Your account is locked" : "Host tools aren't available"}
          body={
            locked
              ? "Moderation, the invite code and the party controls are all suspended while an administrator has this account locked. Nothing has been deleted, and the party carries on without you."
              : "Only the event owner and co-hosts can moderate. If you should have access, ask the host to add you as a co-host — you are matched on the email address you signed in with."
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Host"
          subtitle={activeEvent ? activeEvent.name : "Moderate the queue and manage the invite."}
        />

        {!configured ? (
          <Notice tone="warning" title="Running without a backend">
            <MutedText>
              No Convex deployment is configured, so the queue and the invite are unavailable. Run{" "}
              <MonoText>bun run env:doctor</MonoText> at the repo root to see what is missing.
            </MutedText>
          </Notice>
        ) : eventsLoading ? (
          <Loading label="Finding your parties…" />
        ) : activeEvent === null ? (
          <EmptyState
            icon="qr-code-outline"
            title="No party selected"
            body="Pick a party in Settings to see its queue."
          />
        ) : (
          <HostTools event={activeEvent} />
        )}
      </ScrollView>
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* Everything that talks to Convex                                            */
/* -------------------------------------------------------------------------- */

function HostTools({ event }: { event: EventSummary }) {
  const { roles } = useSession();
  const abilities = useMemo(() => hostAbilities(roles, event.state), [roles, event.state]);

  return (
    <>
      <StatusSection event={event} abilities={abilities} />
      {abilities.viewInviteCode ? <InviteSection event={event} abilities={abilities} /> : null}
      <FlaggedSection event={event} abilities={abilities} />
      <QueueSection event={event} abilities={abilities} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Status and schedule                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The party's state, and the four buttons that move it.
 *
 * "Extend" is `events.update` rather than `events.setState` — pushing the finish
 * time out is a schedule edit, and it is the control a host actually reaches for
 * at 11pm, because the alternative (`archived`, then `live` again) closes the
 * join window for everybody standing outside with a QR code in the meantime.
 *
 * Ending the party is **owner-only** and asks first. A co-host may open, pause
 * and resume; `event.archive` is where PLAN.md draws the line between operating
 * a party and ending one, and the contract enforces it whatever this renders.
 */
function StatusSection({ event, abilities }: { event: EventSummary; abilities: HostAbilities }) {
  const now = useNow();
  const setState = useMutation(api.events.setState);
  const update = useMutation(api.events.update);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const description = describeEventState(event.state);

  const run = useCallback(async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      captureHandledError(caught, { scope: `host.${key}` });
      setError(describeError(caught).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const move = useCallback(
    (key: string, state: "live" | "paused" | "archived") =>
      void run(key, () => setState({ eventId: event.id, state })),
    [event.id, run, setState],
  );

  const extend = useCallback(() => {
    if (event.endsAt === undefined) return;
    void run("extend", () =>
      update({
        eventId: event.id,
        schedule: {
          startsAt: event.startsAt,
          endsAt: event.endsAt === undefined ? undefined : event.endsAt + EXTEND_BY_MS,
          timeZone: event.timeZone,
        },
      }),
    );
  }, [event.endsAt, event.id, event.startsAt, event.timeZone, run, update]);

  return (
    <Card>
      <View style={styles.badges}>
        <Badge label={roleLabel(event.role)} />
        <Badge
          label={description.label}
          tone={description.tone === "live" ? colors.success : colors.textFaint}
        />
      </View>
      <Text style={styles.when}>{describeSchedule(event, now)}</Text>
      <MutedText>
        {`${String(event.counts.pending)} waiting · ${String(event.counts.approved)} approved · ${String(event.counts.total)} in total`}
      </MutedText>

      {/* `changeState` is open in every event state for a host, so the only way
          this is false is a locked account — which the screen-level gate above
          has already caught. It stays as a condition rather than an assumption
          because the day it stops being true, a guest must not find a live
          Pause button here. */}
      {abilities.changeState ? (
        <View style={styles.actions}>
          {event.state === "draft" || event.state === "scheduled" || event.state === "archived" ? (
            <Button
              label={event.state === "archived" ? "Re-open the party" : "Open the party now"}
              icon="play-outline"
              busy={busy === "open"}
              onPress={() => move("open", "live")}
            />
          ) : null}
          {event.state === "live" ? (
            <Button
              label="Pause new photos"
              variant="secondary"
              icon="pause-outline"
              busy={busy === "pause"}
              onPress={() => move("pause", "paused")}
            />
          ) : null}
          {event.state === "paused" ? (
            <Button
              label="Start taking photos again"
              icon="play-outline"
              busy={busy === "resume"}
              onPress={() => move("resume", "live")}
            />
          ) : null}
          {abilities.updateSchedule && event.endsAt !== undefined ? (
            <Button
              label="Give it another hour"
              variant="secondary"
              icon="time-outline"
              busy={busy === "extend"}
              onPress={extend}
            />
          ) : null}
          {abilities.archive && !confirmingArchive ? (
            <Button
              label="End the party"
              variant="secondary"
              icon="stop-circle-outline"
              accessibilityHint="Asks you to confirm first."
              onPress={() => setConfirmingArchive(true)}
            />
          ) : null}
        </View>
      ) : null}

      {confirmingArchive ? (
        <Notice tone="warning" title="End the party?">
          <MutedText>
            No more photos can be sent and the six-digit code stops working. The approved gallery
            stays, and you can re-open it afterwards.
          </MutedText>
          <View style={styles.actions}>
            <Button
              label="Yes, end it"
              variant="danger"
              busy={busy === "archive"}
              onPress={() => {
                setConfirmingArchive(false);
                move("archive", "archived");
              }}
            />
            <Button
              label="Keep it running"
              variant="secondary"
              onPress={() => setConfirmingArchive(false)}
            />
          </View>
        </Notice>
      ) : null}

      {error !== null ? (
        <Notice tone="danger" title="That didn't work">
          <MutedText>{error}</MutedText>
        </Notice>
      ) : null}
    </Card>
  );
}

function roleLabel(role: EventSummary["role"]): string {
  return role === "owner" ? "owner" : role === "cohost" ? "co-host" : role;
}

/* -------------------------------------------------------------------------- */
/* The invite                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The code, the QR, and the button that kills both.
 *
 * The code is spaced `123 456` for reading aloud across a room and rendered in
 * the mono face so 0/O and 1/I cannot be confused. The QR is drawn dark on
 * white regardless of the app's own palette — see `src/components/qr-code.tsx`.
 *
 * Rotation is behind a modal because the choice inside it is the whole feature:
 * "keep everyone in" and "make everyone re-join" are two different acts that a
 * single Rotate button would have to pick between on the host's behalf. The
 * modal asks, and says what each one costs.
 */
function InviteSection({ event, abilities }: { event: EventSummary; abilities: HostAbilities }) {
  const invite = useQuery(api.invites.current, { eventId: event.id });
  const [rotating, setRotating] = useState(false);

  const joinUrl = useMemo(
    () =>
      // `token` is optional on the wire because a global admin is served the
      // code alone; a host always has it, so this is a type-level guard rather
      // than a case the Host tab can reach.
      invite?.token !== undefined && appConfig.status === "ready"
        ? buildJoinUrl(appConfig.siteUrl, invite.token)
        : null,
    [invite],
  );

  return (
    <Card>
      <Text style={styles.sectionLabel}>Let people in</Text>

      {invite === undefined ? (
        <Loading label="Fetching the code…" />
      ) : invite === null ? (
        <MutedText>
          This party has no live invite. Re-open it, or create the invite from the web console.
        </MutedText>
      ) : (
        <>
          <View style={styles.qrWrap}>
            {joinUrl === null ? null : (
              <QrCode value={joinUrl} label={`QR code to join ${event.name}`} />
            )}
          </View>
          <Text style={styles.code} accessibilityLabel={`Join code ${spellOut(invite.code)}`}>
            {formatCode(invite.code)}
          </Text>
          <MutedText>
            {`Invite #${String(invite.version)}. Guests can scan this or type the six digits at ${
              appConfig.status === "ready" ? hostOf(appConfig.siteUrl) : "the website"
            }.`}
          </MutedText>

          {abilities.rotateInvite ? (
            <Button
              label="Rotate the code"
              variant="secondary"
              icon="refresh-outline"
              onPress={() => setRotating(true)}
            />
          ) : null}
        </>
      )}

      <RotateModal visible={rotating} event={event} onClose={() => setRotating(false)} />
    </Card>
  );
}

/** `482913` → `482 913`. Easier to read out and easier to type back. */
function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Digits, spaced, so a screen reader says "four eight two" not "four hundred". */
function spellOut(code: string): string {
  return code.split("").join(" ");
}

function hostOf(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}

/* -------------------------------------------------------------------------- */
/* Rotation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Keep-or-revoke, asked out loud.
 *
 * The default is **keep**, and it is the right default: the overwhelmingly
 * common reason to rotate mid-party is that the printed sign walked off, and the
 * people already inside did nothing wrong. The revoke path exists for the other
 * case — the code got somewhere it should not have — and the copy says what it
 * costs, because a host who turns it on without understanding it will empty
 * their own party at the worst moment.
 *
 * What it does *not* do is ban anybody. `memberships.revokedByRotation` records
 * a sweep as a sweep, so a guest it caught can walk back in on the new code
 * (ADR 0010). The copy says that too, because a host who thinks otherwise will
 * hesitate to use the control that is protecting them.
 */
function RotateModal({
  visible,
  event,
  onClose,
}: {
  readonly visible: boolean;
  readonly event: EventSummary;
  readonly onClose: () => void;
}) {
  const rotate = useMutation(api.invites.rotate);
  const [revoke, setRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; revoked: number } | null>(null);

  // The switch is the phone's way of asking the contract's keep-or-revoke
  // question. Deriving the choice rather than storing it keeps the boolean and
  // the copy from ever describing different rotations.
  const choice: RotationChoice = revoke ? "revoke" : "keep";

  const close = useCallback(() => {
    setError(null);
    setDone(null);
    setRevoke(false);
    onClose();
  }, [onClose]);

  const confirm = useCallback(() => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const result = await rotate({
          eventId: event.id,
          keepExistingMemberships: keepExistingMemberships(choice),
        });
        // Deliberately not closed on success. The new code is the thing the host
        // came for, and dismissing the sheet the instant it exists means reading
        // it off the card behind — which has not re-rendered yet.
        setDone({ code: result.code, revoked: result.revokedMemberships });
      } catch (caught) {
        captureHandledError(caught, { scope: "host.rotate" });
        setError(describeError(caught).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [choice, event.id, rotate]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <View style={styles.modalScrim}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New code and QR</Text>

          {done !== null ? (
            <>
              <Notice tone="success" title="Done — here is the new code">
                <Text style={styles.code}>{formatCode(done.code)}</Text>
                <MutedText>
                  The old QR and the old six digits stop working straight away. Reprint or re-show
                  the sign before anyone else arrives.
                </MutedText>
                {done.revoked > 0 ? (
                  <MutedText>
                    {`${String(done.revoked)} ${done.revoked === 1 ? "guest was" : "guests were"} removed. They can come back in with the new code.`}
                  </MutedText>
                ) : null}
              </Notice>
              <Button label="Done" onPress={close} />
            </>
          ) : (
            <>
              <MutedText>
                A new six-digit code and a new QR. The old ones stop working immediately — that is
                the point — so make sure you can re-show the sign.
              </MutedText>

              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <BodyText>Also remove everyone already in</BodyText>
                  <MutedText>{ROTATION_CONSEQUENCES[choice].summary}</MutedText>
                </View>
                <Switch
                  value={revoke}
                  onValueChange={setRevoke}
                  trackColor={{ true: colors.danger, false: colors.border }}
                  accessibilityLabel="Also remove everyone already in"
                />
              </View>

              {/*
                The consequences, in the contract's words rather than this
                screen's. The console's modal renders the same list from the same
                constant, so a host who read it on a laptop and reads it again
                here is reading one promise.
              */}
              <View style={styles.effects}>
                {ROTATION_CONSEQUENCES[choice].effects.map((effect) => (
                  <MutedText key={effect}>{`• ${effect}`}</MutedText>
                ))}
              </View>

              {error !== null ? (
                <Notice tone="danger" title="That didn't work">
                  <MutedText>{error}</MutedText>
                </Notice>
              ) : null}

              <View style={styles.actions}>
                <Button
                  label={revoke ? "Rotate and remove guests" : "Rotate and keep everyone"}
                  variant={revoke ? "danger" : "primary"}
                  busy={busy}
                  onPress={confirm}
                />
                <Button label="Cancel" variant="secondary" disabled={busy} onPress={close} />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Flagged                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Items somebody in the party reported, above the queue rather than inside it.
 *
 * A report **flags**, it never moderates — auto-hiding on report would hand any
 * guest a veto over any other guest's photograph (ADR 0005). So this is a
 * separate panel with the reason attached, and the host still decides. It
 * appears only when there is something in it: a permanently empty "Reported (0)"
 * card is clutter on a screen somebody opens to clear a queue.
 */
function FlaggedSection({ event, abilities }: { event: EventSummary; abilities: HostAbilities }) {
  const urlRefreshKey = useSignedUrlRefreshKey(SIGNED_HOST_REVIEW_URL_TTL_SECONDS);
  const flagged = useQuery(api.moderation.flagged, {
    eventId: event.id,
    limit: 10,
    urlRefreshKey,
  });
  const resolveReport = useMutation(api.moderation.resolveReport);

  const [resolving, setResolving] = useState<{
    readonly mediaId: string;
    readonly status: "actioned" | "dismissed";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolveAll = useCallback(
    (entry: FlaggedItem, status: "actioned" | "dismissed") => {
      const open = entry.reports.filter((report) => report.status === "open");
      if (open.length === 0 || resolving !== null) return;

      setResolving({ mediaId: entry.media.id, status });
      setError(null);
      // `resolveReport` re-checks whether another open report remains after
      // every write. Keeping these sequential avoids needless transaction
      // conflicts and means a retry can continue with whatever is still open.
      void (async () => {
        let completed = 0;
        try {
          for (const report of open) {
            await resolveReport({ reportId: report.id, status });
            completed += 1;
          }
        } catch (caught) {
          captureHandledError(caught, {
            scope: "host.resolveReports",
            mediaId: entry.media.id,
            status,
            completed,
            total: open.length,
          });
          const message = describeError(caught).message;
          setError(
            completed === 0
              ? message
              : `${String(completed)} of ${String(open.length)} reports were updated. ${message}`,
          );
        } finally {
          setResolving(null);
        }
      })();
    },
    [resolveReport, resolving],
  );

  if (flagged === undefined || flagged.length === 0) return null;

  return (
    <Card>
      <Text style={styles.sectionLabel}>{`Reported (${String(flagged.length)})`}</Text>
      <MutedText>
        Someone in the party flagged these. Nothing has happened to them — reporting asks you to
        look, it does not hide anything.
      </MutedText>
      {error !== null ? (
        <Notice tone="danger" title="Some reports are still open">
          <MutedText>{error}</MutedText>
        </Notice>
      ) : null}
      {flagged.map((entry) => {
        const open = entry.reports.filter((report) => report.status === "open");
        const resolvingThis = resolving?.mediaId === entry.media.id;
        return (
          <View key={entry.media.id} style={styles.flaggedItem}>
            <QueueRow
              event={event}
              media={entry.media}
              abilities={abilities}
              note={entry.reports.map((report) => REPORT_REASON_LABELS[report.reason]).join(" · ")}
            />
            {abilities.moderate && open.length > 0 ? (
              <View style={styles.flaggedActions}>
                <Button
                  label="Mark handled"
                  variant="secondary"
                  busy={resolvingThis && resolving?.status === "actioned"}
                  disabled={resolving !== null}
                  onPress={() => resolveAll(entry, "actioned")}
                />
                <Button
                  label="Dismiss"
                  variant="secondary"
                  busy={resolvingThis && resolving?.status === "dismissed"}
                  disabled={resolving !== null}
                  onPress={() => resolveAll(entry, "dismissed")}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* The queue                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What is waiting, flagged first and then oldest first — the server's order,
 * unchanged.
 *
 * `Approve everything` is offered because at a real party the queue arrives in
 * bursts of thirty and the honest answer to most of them is yes. It is a single
 * `moderation.moderate` call with every id, so a partial refusal (an item
 * another host has already dealt with, or one the submitter withdrew ten seconds
 * ago) comes back itemised rather than failing the lot.
 */
function QueueSection({ event, abilities }: { event: EventSummary; abilities: HostAbilities }) {
  const urlRefreshKey = useSignedUrlRefreshKey(SIGNED_HOST_REVIEW_URL_TTL_SECONDS);
  const pending = useQuery(api.moderation.pending, {
    eventId: event.id,
    limit: QUEUE_LIMIT,
    urlRefreshKey,
  });
  const moderate = useMutation(api.moderation.moderate);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const approveAll = useCallback(() => {
    if (pending === undefined || pending.length === 0) return;
    void (async () => {
      setBusy(true);
      setError(null);
      setRefused(null);
      try {
        const result = await moderate({
          eventId: event.id,
          mediaIds: pending.map((media) => media.id),
          action: "approve",
        });
        if (result.refused.length > 0) {
          setRefused(
            `${String(result.changed)} added. ${String(result.refused.length)} could not be: ${result.refused[0]?.message ?? ""}`,
          );
        }
      } catch (caught) {
        captureHandledError(caught, { scope: "host.approveAll" });
        setError(describeError(caught).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [event.id, moderate, pending]);

  return (
    <Card>
      <Text style={styles.sectionLabel}>Waiting for you</Text>

      {pending === undefined ? (
        <Loading label="Loading the queue…" />
      ) : pending.length === 0 ? (
        <MutedText>
          {event.moderationMode === "automatic"
            ? "Nothing waiting — this party adds photos automatically, so the queue only fills if you switch back to reviewing them."
            : "Nothing waiting. Everything sent so far has been dealt with."}
        </MutedText>
      ) : (
        <>
          <MutedText>
            {`${String(pending.length)}${pending.length === QUEUE_LIMIT ? "+" : ""} waiting. Newest last, and anything reported comes first.`}
          </MutedText>

          {abilities.moderate ? (
            <Button
              label={`Approve everything (${String(pending.length)})`}
              variant="secondary"
              icon="checkmark-done-outline"
              busy={busy}
              onPress={approveAll}
            />
          ) : null}

          {refused !== null ? (
            <Notice tone="warning" title="Some of those had already moved">
              <MutedText>{refused}</MutedText>
            </Notice>
          ) : null}
          {error !== null ? (
            <Notice tone="danger" title="That didn't work">
              <MutedText>{error}</MutedText>
            </Notice>
          ) : null}

          {pending.map((media) => (
            <QueueRow key={media.id} event={event} media={media} abilities={abilities} />
          ))}
        </>
      )}
    </Card>
  );
}

/**
 * One submission, with the two buttons that are the whole job.
 *
 * The thumbnail is whatever signed URL is still valid — the preview if the
 * client uploaded one, the original otherwise, and nothing at all if both have
 * expired. A grey square with a working Approve button beats a broken image and
 * beats blocking review on a re-fetch.
 *
 * Both buttons are disabled while either is in flight, so a double tap cannot
 * approve *and* decline the same photograph.
 */
function QueueRow({
  event,
  media,
  abilities,
  note,
}: {
  readonly event: EventSummary;
  readonly media: MediaItem;
  readonly abilities: HostAbilities;
  readonly note?: string;
}) {
  const now = useNow();
  const moderate = useMutation(api.moderation.moderate);
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uri = usableMediaUri(media, now);
  const avatarUri = usableUploaderAvatarUri(media, now);

  const act = useCallback(
    (action: "approve" | "decline") => {
      void (async () => {
        setBusy(action);
        setError(null);
        try {
          const result = await moderate({
            eventId: event.id,
            mediaIds: [media.id],
            action,
          });
          // A refusal is a value here, not an exception: the item may have moved
          // under us while the list was on screen. Saying so is more useful than
          // a row that silently does nothing.
          const refusal = result.refused[0];
          if (refusal !== undefined) setError(refusal.message);
        } catch (caught) {
          captureHandledError(caught, { scope: "host.moderate", action });
          setError(describeError(caught).message);
        } finally {
          setBusy(null);
        }
      })();
    },
    [event.id, media.id, moderate],
  );

  return (
    <View style={styles.row}>
      <View style={styles.thumb}>
        {uri === undefined ? (
          <Text style={styles.thumbFallback}>{media.mediaType === "video" ? "▶" : "…"}</Text>
        ) : (
          <Image
            source={{ uri }}
            style={styles.thumbImage}
            contentFit="cover"
            accessibilityLabel={`Submission from ${media.uploaderDisplayName}`}
          />
        )}
      </View>

      <View style={styles.rowBody}>
        <View style={styles.uploaderLine}>
          <View style={styles.uploaderAvatar}>
            {avatarUri === undefined ? (
              <Text style={styles.uploaderInitial}>
                {(media.uploaderDisplayName[0] ?? "?").toUpperCase()}
              </Text>
            ) : (
              <Image
                source={{ uri: avatarUri }}
                style={styles.uploaderAvatarImage}
                contentFit="cover"
                accessibilityIgnoresInvertColors
              />
            )}
          </View>
          <Text style={styles.rowName} numberOfLines={1}>
            {media.uploaderDisplayName}
          </Text>
        </View>
        <MutedText>
          {media.mediaType === "video" ? "Video" : "Photo"}
          {media.reportCount !== undefined && media.reportCount > 0
            ? ` · reported ${String(media.reportCount)}×`
            : ""}
        </MutedText>
        {note === undefined || note.length === 0 ? null : <MutedText>{note}</MutedText>}
        {error !== null ? <Text style={styles.rowError}>{error}</Text> : null}
      </View>

      {abilities.moderate ? (
        <View style={styles.rowActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Approve ${media.uploaderDisplayName}'s ${media.mediaType}`}
            disabled={busy !== null}
            onPress={() => act("approve")}
            style={({ pressed }) => [
              styles.quick,
              styles.quickApprove,
              pressed && styles.quickPressed,
            ]}
          >
            <Text style={styles.quickLabel}>Add</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Decline ${media.uploaderDisplayName}'s ${media.mediaType}`}
            disabled={busy !== null}
            onPress={() => act("decline")}
            style={({ pressed }) => [
              styles.quick,
              styles.quickDecline,
              pressed && styles.quickPressed,
            ]}
          >
            <Text style={styles.quickLabel}>No</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl, gap: spacing.lg },
  badges: { flexDirection: "row", gap: spacing.sm },
  when: { ...typography.heading, color: colors.text },
  sectionLabel: { ...typography.label, color: colors.textMuted, textTransform: "uppercase" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },

  qrWrap: { alignItems: "center", paddingVertical: spacing.sm },
  code: {
    ...typography.display,
    color: colors.text,
    textAlign: "center",
    letterSpacing: 4,
    fontVariant: ["tabular-nums"],
  },

  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: { ...typography.title, color: colors.text },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  switchCopy: { flex: 1, gap: spacing.xs },
  effects: { gap: spacing.xs },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowBody: { flex: 1, gap: spacing.xs },
  uploaderLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  uploaderAvatar: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accentSoft,
  },
  uploaderAvatarImage: { width: "100%", height: "100%" },
  uploaderInitial: { ...typography.caption, color: colors.accent },
  rowName: { ...typography.body, color: colors.text },
  rowError: { ...typography.caption, color: colors.danger },
  rowActions: { flexDirection: "row", gap: spacing.sm },
  flaggedItem: { gap: spacing.sm },
  flaggedActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFallback: { ...typography.body, color: colors.textFaint },
  quick: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    minWidth: 52,
    alignItems: "center",
  },
  quickApprove: { backgroundColor: colors.success },
  quickDecline: { backgroundColor: colors.surfaceRaised },
  quickPressed: { opacity: 0.7 },
  quickLabel: { ...typography.label, color: colors.bg },
});
