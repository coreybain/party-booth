import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from "@partybooth/contracts/push";

/**
 * The push seam.
 *
 * Same shape and same argument as the storage adapter (ADR 0002): *"the adapter
 * is only worth having if nothing bypasses it."* Nothing in `convex/` calls
 * `exp.host` directly; everything goes through {@link PushAdapter}, which means
 * the entire notification stack — preferences, debounce, chunking, receipt
 * handling, token pruning — is unit-testable with **no network and no
 * credentials**, which is the hard constraint the whole repository is built to.
 *
 * The interface is deliberately Expo-shaped rather than generic. A generic
 * "notifier" would have to invent a ticket concept to keep the receipt check,
 * and the receipt check is the only thing that can tell a dead token from a
 * quiet one. There is one provider and it is named in PLAN.md; pretending
 * otherwise would buy an abstraction nobody is going to spend.
 */
export interface PushAdapter {
  readonly provider: "expo" | "fake" | "unconfigured";
  readonly configured: boolean;

  /**
   * Deliver one chunk of at most `EXPO_PUSH_SEND_CHUNK_SIZE` messages.
   *
   * Returns one ticket per message, **in order** — that ordering is how the
   * caller maps a ticket back to the notification row it belongs to, and an
   * implementation that reorders would silently attribute failures to the wrong
   * device. Implementations must not throw for a per-message failure; a refused
   * message is an `error` ticket. They may throw for a transport failure, which
   * the caller treats as "the whole chunk is unsent".
   */
  sendChunk(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]>;

  /**
   * Read receipts for tickets Expo accepted earlier.
   *
   * Keyed by ticket id. A missing key means "no receipt yet", which is not an
   * error: Expo keeps them for twenty-four hours and produces them when it has
   * heard back from Apple or Google.
   */
  getReceipts(ticketIds: readonly string[]): Promise<Record<string, ExpoPushReceipt>>;

  describe(): PushAdapterDescription;
}

export interface PushAdapterDescription {
  provider: PushAdapter["provider"];
  configured: boolean;
  /** `true` when an Expo access token is in play (enhanced push security). */
  authenticated: boolean;
}

/**
 * Thrown by the unconfigured adapter.
 *
 * Never fatal on a request path: a party where nobody's phone buzzes is a party,
 * and a party where approving a photo throws because `EAS_PROJECT_ID` is unset
 * is not. The dispatcher catches this and marks the notifications `dropped`.
 */
export class PushNotConfiguredError extends Error {
  override readonly name = "PushNotConfiguredError";
  constructor() {
    super(
      "Expo push is not configured on this deployment. Set EAS_PROJECT_ID (and optionally EXPO_ACCESS_TOKEN) — run `bun run env:doctor` for the list.",
    );
  }
}
