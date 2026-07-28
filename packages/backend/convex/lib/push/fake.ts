import type {
  ExpoPushErrorCode,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket,
} from "@partybooth/contracts/push";

import type { PushAdapter } from "./adapter";

/**
 * An in-memory Expo, for tests.
 *
 * It records what it was asked to send and lets a suite script the two answers
 * that actually matter: a ticket that refuses a message outright, and a receipt
 * that reports `DeviceNotRegistered` fifteen minutes later. Those are the two
 * shapes the pruning logic exists for, and neither is reachable against the real
 * service without a real dead phone.
 */

export interface FakePushOptions {
  /** Token → error code returned on the **ticket** (send-time refusal). */
  ticketErrors?: Record<string, ExpoPushErrorCode>;
  /** Token → error code returned on the **receipt** (delivery-time failure). */
  receiptErrors?: Record<string, ExpoPushErrorCode>;
  /** Ticket ids to withhold a receipt for, i.e. "Expo has not decided yet". */
  withholdReceipts?: readonly string[];
  /** Make `sendChunk` throw, as a transport failure would. */
  failTransport?: boolean;
}

export interface FakePushAdapter extends PushAdapter {
  /** Every message handed to `sendChunk`, flattened, in order. */
  readonly sent: ExpoPushMessage[];
  /** The chunk sizes it was called with — the thing chunking tests assert. */
  readonly chunkSizes: number[];
  /** Every ticket id it has been asked about. */
  readonly receiptQueries: string[];
  /** Which token a ticket id belongs to, for assertions. */
  tokenForTicket(ticketId: string): string | undefined;
  reset(): void;
}

export function createFakePushAdapter(options: FakePushOptions = {}): FakePushAdapter {
  const sent: ExpoPushMessage[] = [];
  const chunkSizes: number[] = [];
  const receiptQueries: string[] = [];
  const ticketToToken = new Map<string, string>();
  let counter = 0;

  const withheld = new Set(options.withholdReceipts ?? []);

  const adapter: FakePushAdapter = {
    provider: "fake",
    configured: true,
    sent,
    chunkSizes,
    receiptQueries,

    async sendChunk(messages) {
      if (options.failTransport === true) {
        throw new Error("fake push transport failure");
      }
      chunkSizes.push(messages.length);

      const tickets: ExpoPushTicket[] = [];
      for (const message of messages) {
        sent.push(message);
        const ticketError = options.ticketErrors?.[message.to];
        if (ticketError !== undefined) {
          tickets.push({
            status: "error",
            message: `fake ticket error: ${ticketError}`,
            details: { error: ticketError },
          });
          continue;
        }
        counter += 1;
        const id = `ticket-${counter}`;
        ticketToToken.set(id, message.to);
        tickets.push({ status: "ok", id });
      }
      return tickets;
    },

    async getReceipts(ticketIds) {
      const out: Record<string, ExpoPushReceipt> = {};
      for (const id of ticketIds) {
        receiptQueries.push(id);
        if (withheld.has(id)) continue;
        const token = ticketToToken.get(id);
        const error = token === undefined ? undefined : options.receiptErrors?.[token];
        out[id] =
          error === undefined
            ? { status: "ok" }
            : { status: "error", message: `fake receipt error: ${error}`, details: { error } };
      }
      return out;
    },

    tokenForTicket: (ticketId) => ticketToToken.get(ticketId),

    reset() {
      sent.length = 0;
      chunkSizes.length = 0;
      receiptQueries.length = 0;
      ticketToToken.clear();
      counter = 0;
    },

    describe: () => ({ provider: "fake", configured: true, authenticated: false }),
  };

  return adapter;
}
