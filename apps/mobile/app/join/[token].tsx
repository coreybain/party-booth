import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";

import {
  Badge,
  BodyText,
  Button,
  Card,
  MonoText,
  MutedText,
  Notice,
  Screen,
  ScreenHeader,
} from "@/components/ui";
import { isJoinToken, normaliseJoinCode } from "@/lib/deep-links";
import { useSession } from "@/providers/session";
import { spacing } from "@/theme";

/**
 * Join deep-link target — route stub.
 *
 * Reached three ways, all of which land here (see `src/lib/deep-links.ts`):
 *   - `https://<site>/join/<token>` — the printed QR, via iOS associated domains and
 *     Android verified App Links (both declared in app.config.ts)
 *   - `partybooth://join/<token>`   — app-to-app
 *   - typing the six-digit code
 *
 * Sprint 2 replaces the placeholder below with the real, rate-limited, audited join
 * mutation. What already works here is the routing and the input classification, so the
 * universal-link plumbing can be verified on a device before the backend exists.
 */
export default function JoinRoute() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { state, configured } = useSession();

  const raw = typeof token === "string" ? token : "";
  const asCode = normaliseJoinCode(raw);
  const asToken = !asCode && isJoinToken(raw) ? raw : null;
  const recognised = asCode !== null || asToken !== null;

  const signedIn = state.status === "signed-in";

  return (
    <Screen edges={["left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title={recognised ? "You've been invited" : "That invite didn't work"}
          subtitle={
            recognised
              ? "Confirm to join the event and start sending photos."
              : "The link may have been rotated by the host, or mistyped."
          }
        />

        {recognised ? (
          <Card>
            <Badge label={asCode ? "six-digit code" : "invite token"} />
            <BodyText>
              {asCode ? "Code " : "Token "}
              <MonoText>{asCode ?? maskToken(asToken ?? "")}</MonoText>
            </BodyText>
            <MutedText>
              Hosts rotate invites during an event. If this one has been revoked, ask for the
              current code — the old QR stops working immediately.
            </MutedText>
          </Card>
        ) : (
          <Notice tone="danger" title="Invite not recognised">
            <MutedText>
              Join codes are six digits. If you scanned a QR, try again in better light, or type the
              code printed underneath it.
            </MutedText>
          </Notice>
        )}

        <Notice tone="info" title="Joining isn't wired up yet">
          <Badge label="sprint 2" />
          <MutedText>
            The join mutation — authenticated, rate-limited, enumeration-protected and audited —
            plus membership creation land in Sprint 2.
          </MutedText>
        </Notice>

        {!signedIn ? (
          <Button
            label="Sign in to join"
            icon="log-in-outline"
            onPress={() => router.replace("/sign-in")}
            disabled={!configured}
          />
        ) : (
          <Button label="Close" variant="secondary" onPress={() => router.back()} />
        )}
      </ScrollView>
    </Screen>
  );
}

/** Invite tokens are secrets; show only enough to tell two apart in a screenshot. */
function maskToken(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
});
