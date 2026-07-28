import {
  EXPO_PUSH_RECEIPTS_ENDPOINT,
  EXPO_PUSH_RECEIPT_CHUNK_SIZE,
  EXPO_PUSH_SEND_CHUNK_SIZE,
  EXPO_PUSH_SEND_ENDPOINT,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "@partybooth/contracts/push";

import type { PushAdapter, PushAdapterDescription } from "./adapter";

/**
 * The real Expo push service, over plain `fetch`.
 *
 * Deliberately not `expo-server-sdk`: the Convex runtime is a V8 isolate rather
 * than Node, and the SDK's value is chunking plus retries, both of which are
 * twelve lines we already own and can test offline. Same trade, same reasoning,
 * as `lib/email/resend.ts`.
 *
 * Built against
 * <https://docs.expo.dev/push-notifications/sending-notifications/> as of
 * 28 July 2026, which specifies:
 *
 * - `POST https://exp.host/--/api/v2/push/send`, at most **100** messages per
 *   request, `{ "data": [ …tickets… ] }` back, one ticket per message in order;
 * - `POST https://exp.host/--/api/v2/push/getReceipts` with `{ "ids": [...] }`,
 *   at most **1000** ids, `{ "data": { "<id>": {…} } }` back;
 * - `accept: application/json`, `accept-encoding: gzip, deflate`,
 *   `content-type: application/json`, and `Authorization: Bearer …` when the
 *   project has enhanced security switched on;
 * - 4096 bytes per notification, 600 notifications/second per project, and
 *   exponential backoff on 429 and 5xx.
 *
 * The chunking is enforced **here** as well as by the caller, because the
 * caller's chunk size is a constant and this is the thing that gets a `400` if
 * they ever disagree.
 */

export interface ExpoPushAdapterOptions {
  /** `EXPO_ACCESS_TOKEN`, when the project uses enhanced push security. */
  accessToken?: string | undefined;
  /** Overridable so tests never touch the network. */
  fetchImpl?: typeof fetch | undefined;
}

interface ExpoEnvelope<T> {
  data?: T;
  errors?: { code?: string; message?: string }[];
}

export function createExpoPushAdapter(options: ExpoPushAdapterOptions = {}): PushAdapter {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const headers = (): Record<string, string> => ({
    accept: "application/json",
    "accept-encoding": "gzip, deflate",
    "content-type": "application/json",
    ...(options.accessToken === undefined
      ? {}
      : { authorization: `Bearer ${options.accessToken}` }),
  });

  async function post<T>(url: string, body: unknown): Promise<ExpoEnvelope<T>> {
    const response = await doFetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ExpoPushTransportError(response.status, truncate(detail, 400));
    }

    return (await response.json()) as ExpoEnvelope<T>;
  }

  const description: PushAdapterDescription = {
    provider: "expo",
    configured: true,
    authenticated: options.accessToken !== undefined,
  };

  return {
    provider: "expo",
    configured: true,

    async sendChunk(messages) {
      if (messages.length === 0) return [];
      if (messages.length > EXPO_PUSH_SEND_CHUNK_SIZE) {
        throw new RangeError(
          `Expo accepts at most ${EXPO_PUSH_SEND_CHUNK_SIZE} messages per request; got ${messages.length}.`,
        );
      }

      const envelope = await post<ExpoPushTicket[]>(EXPO_PUSH_SEND_ENDPOINT, [
        ...toWireMessages(messages),
      ]);
      const tickets = envelope.data ?? [];

      /*
       * A short `data` array is a protocol violation, and treating it as
       * "everything after position N succeeded" would mark real notifications
       * sent that were never accepted. Pad with a synthetic error instead, so the
       * caller counts a failure and retries rather than losing the message
       * silently.
       */
      if (tickets.length < messages.length) {
        const missing = messages.length - tickets.length;
        for (let index = 0; index < missing; index += 1) {
          tickets.push({
            status: "error",
            message: "Expo returned fewer tickets than messages sent.",
          });
        }
      }
      return tickets.slice(0, messages.length);
    },

    async getReceipts(ticketIds) {
      if (ticketIds.length === 0) return {};
      if (ticketIds.length > EXPO_PUSH_RECEIPT_CHUNK_SIZE) {
        throw new RangeError(
          `Expo accepts at most ${EXPO_PUSH_RECEIPT_CHUNK_SIZE} receipt ids per request; got ${ticketIds.length}.`,
        );
      }
      const envelope = await post<Record<string, ExpoPushReceipt>>(EXPO_PUSH_RECEIPTS_ENDPOINT, {
        ids: [...ticketIds],
      });
      return envelope.data ?? {};
    },

    describe: () => ({ ...description }),
  };
}

/**
 * Strip anything that is not part of the documented message shape.
 *
 * `undefined` fields serialise to nothing in JSON, but an explicit `sound: null`
 * is meaningful to Expo (silent notification) and has to survive, so the mapping
 * is written out rather than spread.
 */
function toWireMessages(messages: readonly ExpoPushMessage[]): Record<string, unknown>[] {
  return messages.map((message) => ({
    to: message.to,
    title: message.title,
    body: message.body,
    ...(message.data === undefined ? {} : { data: message.data }),
    ...(message.sound === undefined ? {} : { sound: message.sound }),
    ...(message.badge === undefined ? {} : { badge: message.badge }),
    ...(message.channelId === undefined ? {} : { channelId: message.channelId }),
  }));
}

/** A non-2xx from `exp.host`. The whole chunk is unsent. */
export class ExpoPushTransportError extends Error {
  override readonly name = "ExpoPushTransportError";
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Expo push responded ${status}${detail ? `: ${detail}` : ""}`);
  }

  /** 429 and 5xx are worth another go; a 4xx means we sent something wrong. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
