import { useQuery } from "convex/react";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import {
  Badge,
  BodyText,
  Button,
  Card,
  Loading,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { SetupRequired } from "@/components/setup-required";
import { appConfig } from "@/env";
import { useJoinEvent } from "@/hooks/use-join";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { parseJoinLink, type JoinTarget } from "@/lib/deep-links";
import { describeEvent, describeJoinWindow, describeSchedule } from "@/lib/events";
import { JOIN_REJECTED_MESSAGE } from "@/lib/join";
import { rememberPendingInvite } from "@/lib/pending-invite";
import { useSession } from "@/providers/session";
import { colors, spacing, typography } from "@/theme";

/**
 * The deep-link join target.
 *
 * Every scanned or tapped invite reaches this screen, and Expo Router maps all of them
 * onto the same path, so there is nothing to branch on here:
 *
 *   - `https://<site>/join/<token>` — the printed QR, via iOS associated domains and
 *     Android verified App Links (both declared in `app.config.ts`, and both backed by
 *     the association documents `apps/web` serves from `/.well-known/`)
 *   - `partybooth://join/<token>`   — app-to-app, and OAuth returning mid-join
 *   - `https://<site>/join?code=…`  — a code shared as a plain link
 *
 * Classification is `parseJoinLink`'s job (`src/lib/deep-links.ts`), which normalises a
 * token into the Crockford form Convex stores *before* it leaves the device — so a
 * token transcribed off signage in lower case is not bounced by the backend.
 *
 * The preview is a **query, and unauthenticated on purpose**: a token is 160 bits, so
 * there is nothing to enumerate, and a guest arriving from a QR needs to see whose
 * party this is before deciding to sign in. A typed code gets no preview — that
 * asymmetry is the enumeration protection, not an oversight.
 *
 * **The file is split in two**, and the split is load-bearing rather than tidiness.
 * A universal link opens this route *directly*, bypassing `app/index.tsx` and its
 * configuration gate — so on a build with an empty environment there is no
 * `ConvexProvider` anywhere above it (see `src/providers/index.tsx`), and the first
 * `useQuery`/`useMutation` throws "Could not find Convex client". Everything that
 * touches a Convex hook therefore lives in {@link JoinByTokenLive}, which is only
 * mounted once the configuration is known to exist.
 */
export default function JoinRoute() {
  const router = useRouter();
  const { token: rawParam } = useLocalSearchParams<{ token: string }>();

  const raw = typeof rawParam === "string" ? rawParam : "";
  // Put the segment back through the parser a full URL would take, so a token and a
  // code arriving by any door are classified by exactly one piece of code.
  const target =
    raw.length === 0 ? null : parseJoinLink(`https://join.invalid/join/${encodeURIComponent(raw)}`);

  // A bare `/join` with nothing after it is the code-entry screen, not an error.
  if (raw.length === 0) return <Redirect href="/join" />;

  /* ------------------------------------------------------------------ */
  /* Nothing usable in the link                                         */
  /* ------------------------------------------------------------------ */

  if (!target) {
    return (
      <Screen edges={["left", "right", "bottom"]}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <ScreenHeader
            title="That invite didn't work"
            subtitle="The link may have been cut short when it was shared, or mistyped."
          />
          <Notice tone="danger" title="Invite not recognised">
            {/* The same sentence a rejected join gets. A link this app can tell is
                malformed and a link the backend refuses have to read identically, or
                the difference tells a guesser which half of the check they failed. */}
            <BodyText>{JOIN_REJECTED_MESSAGE}</BodyText>
            <MutedText>
              If you scanned a QR code, try again in better light. Otherwise type the six-digit code
              printed underneath it.
            </MutedText>
          </Notice>
          <Button
            label="Enter the code instead"
            icon="keypad-outline"
            onPress={() => router.replace("/join")}
          />
        </ScrollView>
      </Screen>
    );
  }

  /* ------------------------------------------------------------------ */
  /* No backend to ask                                                  */
  /* ------------------------------------------------------------------ */

  if (appConfig.status === "unconfigured") {
    return (
      <SetupRequired
        missing={appConfig.missing}
        title="This invite can't be opened yet"
        subtitle="The link is fine — this build has no backend configured to check it against."
      />
    );
  }

  return <JoinByTokenLive target={target} />;
}

/* -------------------------------------------------------------------------- */
/* The live screen — Convex hooks live below this line only                   */
/* -------------------------------------------------------------------------- */

function JoinByTokenLive({ target }: { target: JoinTarget }) {
  const router = useRouter();
  const { state, configured } = useSession();
  const { phase, busy, attempt, retrySwitch } = useJoinEvent();
  const now = useNow();

  const preview = useQuery(
    api.join.previewByToken,
    target.kind === "token" ? { token: target.token } : "skip",
  );

  const signedIn = state.status === "signed-in";
  const needsOnboarding =
    state.status === "signed-in" && (state.needsOnboarding || state.needsTermsAcceptance);
  const loadingPreview = target.kind === "token" && preview === undefined;

  const join = useCallback(async () => {
    if (busy) return;
    await attempt(
      target.kind === "token"
        ? { via: "token", token: target.token }
        : { via: "code", code: target.code },
    );
  }, [attempt, busy, target]);

  useEffect(() => {
    if (phase.status !== "joined") return;
    // Landing on the party is the point of the whole flow, so the screen closes
    // itself — but only once the active-event switch has actually succeeded, which is
    // what `joined` now means. Navigating on a failed switch points the Camera tab at
    // whichever party the guest was at before.
    const timer = setTimeout(() => router.replace("/camera"), 600);
    return () => clearTimeout(timer);
  }, [phase.status, router]);

  /* ------------------------------------------------------------------ */
  /* Onboarding comes first                                             */
  /* ------------------------------------------------------------------ */

  // A guest whose sign-in completed but who never confirmed a name can reach this
  // screen directly from a QR, and joining from here would put "j.smith82" in the
  // host's moderation queue — the exact thing the name step exists to prevent. Park
  // the invite and send them through it; `/onboarding` returns to `/`, which consumes
  // the parked invite and lands them back here.
  if (needsOnboarding) {
    rememberPendingInvite(target);
    return <Redirect href="/onboarding" />;
  }

  const description = preview ? describeEvent(preview, now) : null;
  const windowNote = preview ? describeJoinWindow(preview, now) : null;
  const deadToken = target.kind === "token" && preview === null;

  return (
    <Screen edges={["left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title={preview ? preview.name : "You've been invited"}
          subtitle={
            preview
              ? `Hosted by ${preview.hostDisplayName}`
              : "Confirm to join and start sending photos."
          }
        />

        {/* `Loading` is `flex: 1`; inside a scroll view it needs a block to fill. */}
        {loadingPreview ? (
          <View style={styles.loadingBlock}>
            <Loading label="Checking that invite…" />
          </View>
        ) : null}

        {preview ? (
          <Card>
            <View style={styles.badges}>
              <Badge
                label={description?.label ?? preview.state}
                tone={description?.tone === "live" ? colors.success : colors.accentSoft}
              />
              {preview.alreadyMember ? <Badge label="already in" /> : null}
            </View>
            <Text style={styles.when}>{describeSchedule(preview, now)}</Text>
            {description ? <MutedText>{description.detail}</MutedText> : null}
          </Card>
        ) : null}

        {/* Only ever shown for an event the guest has already been told about — never
            as an explanation for a refusal, which by design carries no reason. */}
        {windowNote ? (
          <Notice tone="warning" title="Not open yet">
            <MutedText>{windowNote}</MutedText>
          </Notice>
        ) : null}

        {/* A token that resolves to nothing looks the same as a rotated one and the
            same as a party that has finished. That is deliberate. */}
        {deadToken ? (
          <Notice tone="danger" title="That invite didn't work">
            <BodyText>{JOIN_REJECTED_MESSAGE}</BodyText>
            <MutedText>
              Hosts rotate the QR during a party, so a screenshot or last month&apos;s sign goes
              stale. Ask whoever is hosting for the current one.
            </MutedText>
          </Notice>
        ) : null}

        {phase.status === "refused" ? (
          <Notice tone="danger" title={phase.copy.title}>
            <BodyText>{phase.copy.message}</BodyText>
            <MutedText>{phase.copy.hint}</MutedText>
          </Notice>
        ) : null}

        {phase.status === "error" ? (
          <Notice tone="danger" title={phase.copy.title}>
            <MutedText>{phase.copy.message}</MutedText>
          </Notice>
        ) : null}

        {/* In the party, pointed at the wrong one. Retrying the switch is a different
            action from retrying the join, and costs nothing against the throttle. */}
        {phase.status === "switch-failed" ? (
          <>
            <Notice tone="warning" title={phase.copy.title}>
              <MutedText>{phase.copy.message}</MutedText>
            </Notice>
            <Button
              label="Switch to this party"
              icon="refresh"
              onPress={() => void retrySwitch()}
            />
          </>
        ) : null}

        {phase.status === "joined" ? (
          <Notice tone="success" title={phase.alreadyMember ? "You're already in" : "You're in"}>
            <MutedText>Taking you to the party…</MutedText>
          </Notice>
        ) : null}

        {signedIn ? (
          <Button
            label={preview?.alreadyMember === true ? "Open the party" : "Join the party"}
            icon="arrow-forward"
            onPress={() => void join()}
            disabled={phase.status === "joined" || phase.status === "switch-failed" || deadToken}
            busy={busy}
          />
        ) : (
          <>
            <Button
              label="Sign in to join"
              icon="log-in-outline"
              // Park the invite so the guest comes back to *this* party rather than an
              // empty Camera tab. `app/index.tsx` consumes it after onboarding.
              onPress={() => {
                rememberPendingInvite(target);
                router.replace("/sign-in");
              }}
              disabled={!configured}
            />
            <MutedText>
              Signing in is what lets you withdraw a photo later, and lets the host see who sent
              what. PartyBooth is invitation-only and 18+.
            </MutedText>
          </>
        )}

        <Button label="Close" variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  loadingBlock: { height: 120 },
  badges: { flexDirection: "row", gap: spacing.sm },
  when: { ...typography.heading, color: colors.text },
});
