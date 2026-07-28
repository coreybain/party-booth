/**
 * The seam between the upload queue and however bytes actually leave the phone.
 *
 * This exists for the same reason `packages/backend`'s `StorageAdapter` does: no
 * test in this repo may need a credential, a deployment, or a network. The queue
 * — retries, backoff, cancellation, foreground resume, the whole reason this
 * sprint is the risky one — is exercised against {@link createFakeTransport} in
 * plain Node, and the UploadThing implementation behind
 * `./transport-uploadthing` is the only file that knows a provider exists.
 *
 * It is also a hedge. ADR 0004 records that the UploadThing SDK has never been
 * run in a Convex isolate; the mirror-image risk on this side is a React Native
 * bundle. If either has to change, one file does.
 *
 * What the transport is **not**: it is not where permission lives. By the time
 * anything here runs, Convex has already issued a bound, single-use grant, and
 * the `secret` below is that grant. The transport's whole job is to move bytes
 * and to say whether they arrived.
 *
 * No React Native imports — the interface and the fake are unit-tested in plain
 * Node.
 */

import type { UploadTicket } from "@partybooth/contracts/upload";

/** A local file, described the way both React Native and the SDK want it. */
export interface UploadFileDescriptor {
  /** `file://` path to the submitted original. */
  readonly uri: string;
  /** Filename the provider records. Derived from the capture id, never the camera's. */
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface UploadRequest {
  readonly file: UploadFileDescriptor;
  /**
   * The upload ticket — `@partybooth/contracts/upload`'s
   * {@link UploadTicket}, built by `buildUploadTicket` from the grant.
   *
   * This is the whole input the route handler in `apps/web` parses. It used to
   * be just `ticket.secret`, and the route handler has always required the rest:
   * the two sides sat in two packages that do not import one another, so nothing
   * caught it until they were put in the same room. The shape now has exactly
   * one definition, in contracts, which both this app and the route handler
   * parse against.
   *
   * `ticket.secret` is the grant. It rides through the route handler's
   * `.middleware()` into `onUploadComplete`, which is what lets the server tie
   * the stored object back to the exact capture it was granted for. It is never
   * logged, never persisted and never sent to Sentry: it is a capability.
   */
  readonly ticket: UploadTicket;
  /** Aborting is how "cancel" reaches a request that is already in flight. */
  readonly signal?: AbortSignal | undefined;
  /** 0–1. Called often; the queue throttles what it does with it. */
  readonly onProgress?: ((fraction: number) => void) | undefined;
}

/**
 * Thrown when the guest cancelled. Distinguished from a failure on purpose: a
 * cancelled item is terminal and must not be retried, counted as a failure, or
 * reported to Sentry.
 */
export class UploadCancelledError extends Error {
  override readonly name = "UploadCancelledError";

  constructor() {
    super("Upload cancelled.");
  }
}

/**
 * Has this request been cancelled?
 *
 * A function rather than an inline `signal?.aborted === true`, because the
 * property is read repeatedly across awaits and TypeScript narrows the first
 * check for the rest of the block — which would make every later check look
 * unreachable while the value it reads is genuinely changing underneath.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export function isUploadCancelled(error: unknown): boolean {
  if (error instanceof UploadCancelledError) return true;
  // `AbortSignal` rejections and the SDK's own aborted error both surface as a
  // name rather than a class the app can import.
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "UploadAbortedError";
}

export interface UploadTransport {
  /**
   * Send one file. Resolves when the provider has it; throws otherwise.
   *
   * Deliberately returns nothing. What is *in* storage is not something a client
   * gets to assert — `media.confirmUpload` says only "I stopped waiting", and
   * the file key never comes near a phone (ADR 0004 §5).
   */
  upload(request: UploadRequest): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The fake                                                                   */
/* -------------------------------------------------------------------------- */

export interface FakeTransportOptions {
  /**
   * Decide what happens to each attempt. Return `"ok"` to succeed, or throw.
   * Called with the request and a 1-based attempt counter for that capture, so
   * a test can say "fail twice, then succeed" without any shared mutable state.
   */
  readonly respond?: (request: UploadRequest, attempt: number) => "ok" | Promise<"ok">;
  /** Progress fractions to emit before resolving. Defaults to a single 1. */
  readonly progress?: readonly number[];
}

export interface FakeTransport extends UploadTransport {
  /** Every request the queue made, in order. */
  readonly requests: readonly UploadRequest[];
  /** Attempts per capture, for assertions about retries. */
  attemptsFor(captureId: string): number;
}

/**
 * An in-memory transport for tests and for a build with no site URL.
 *
 * It is a real implementation of the interface, not a stub: it honours the abort
 * signal, emits progress, and can be told to fail. That matters because the
 * behaviour under test *is* the retry ladder, and a fake that always succeeds
 * tests nothing.
 */
export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const requests: UploadRequest[] = [];
  const attempts = new Map<string, number>();

  return {
    requests,
    attemptsFor: (captureId) => attempts.get(captureId) ?? 0,
    async upload(request) {
      requests.push(request);
      const key = request.ticket.captureId;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);

      if (isAborted(request.signal)) throw new UploadCancelledError();

      for (const fraction of options.progress ?? [1]) {
        if (isAborted(request.signal)) throw new UploadCancelledError();
        request.onProgress?.(fraction);
      }

      if (options.respond) await options.respond(request, attempt);
    },
  };
}
