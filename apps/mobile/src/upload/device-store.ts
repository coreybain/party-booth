/**
 * The little bit of filesystem the upload queue owns.
 *
 * Two things are stored, and they are stored as **files in the document
 * directory**, not in `expo-secure-store`:
 *
 * - `queue.json` — everything waiting to be sent.
 * - `capture-settings.json` — auto-send and the undo delay.
 * - `captures/` — the re-encoded originals and their local thumbnails.
 *
 * Why not SecureStore, given `local-profile.ts` uses it? Two reasons, both
 * about size. Android's keystore-backed store is documented as unsuitable for
 * values beyond a couple of kilobytes, and a guest with thirty queued captures
 * is well past that. And none of this is a secret — it is a list of files on
 * the same device, protected by the same lock screen. The grant secret, which
 * *is* a capability, is deliberately never written here at all: it lives for two
 * minutes in memory and dies with the attempt.
 *
 * Why the document directory rather than the cache: iOS and Android both evict
 * the cache directory under storage pressure, and "the queue survived a restart
 * but the photos did not" is a worse failure than not having a queue.
 *
 * Every function swallows its errors, the way `local-profile.ts` does. A phone
 * that cannot write a file must degrade to "this capture is not durable", never
 * to a crash on the shutter button.
 */

import { Directory, File, Paths } from "expo-file-system";

import { captureHandledError } from "../lib/sentry";

const ROOT_DIRECTORY_NAME = "partybooth";
const CAPTURES_DIRECTORY_NAME = "captures";

export const QUEUE_FILE_NAME = "queue.json";
export const CAPTURE_SETTINGS_FILE_NAME = "capture-settings.json";

function rootDirectory(): Directory {
  return new Directory(Paths.document, ROOT_DIRECTORY_NAME);
}

/**
 * The directory captured originals and previews live in.
 *
 * Created on demand rather than at import: module scope runs during the first
 * render, and a filesystem call there would put a synchronous native round trip
 * on the path to the first frame.
 */
export function capturesDirectory(): Directory {
  const directory = new Directory(rootDirectory(), CAPTURES_DIRECTORY_NAME);
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/** Read a JSON blob written by {@link writeStoreFile}. `null` when absent. */
export async function readStoreFile(name: string): Promise<string | null> {
  try {
    const file = new File(rootDirectory(), name);
    if (!file.exists) return null;
    return await file.text();
  } catch (error) {
    captureHandledError(error, { scope: "upload.readStoreFile", name });
    return null;
  }
}

/**
 * Write a JSON blob, creating the directory if this is the first time.
 *
 * `File.write` is synchronous by design in the current expo-file-system, so this
 * is a blocking call on the JS thread. That is why the queue debounces its
 * writes rather than persisting on every progress event — see `queue-provider`.
 */
export async function writeStoreFile(name: string, contents: string): Promise<void> {
  try {
    const directory = rootDirectory();
    if (!directory.exists) directory.create({ intermediates: true });
    const file = new File(directory, name);
    if (!file.exists) file.create();
    file.write(contents);
  } catch (error) {
    captureHandledError(error, { scope: "upload.writeStoreFile", name });
  }
}

/**
 * Delete a capture's local file.
 *
 * Used when a capture is undone, cancelled, or has been on the server long
 * enough that the device copy is dead weight. Silent about a file that is
 * already gone: a sweep that runs twice must not report the second run as a
 * failure, and "the file we wanted deleted is not there" is the desired state.
 */
export async function deleteLocalFile(uri: string | undefined): Promise<void> {
  if (uri === undefined || uri.length === 0) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    captureHandledError(error, { scope: "upload.deleteLocalFile" });
  }
}

/**
 * Bytes of a local file, for hashing. Throws — the caller has to handle it.
 *
 * The return type is `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`
 * because `expo-crypto`'s `digest` takes a `BufferSource`, and a `Uint8Array`
 * over a possibly-shared buffer is not one. Narrowing here rather than casting
 * at the call site keeps the assertion next to the thing that knows it is true.
 */
export async function readLocalBytes(uri: string): Promise<Uint8Array<ArrayBuffer>> {
  return await new File(uri).bytes();
}

/** Absolute `file://` URI for a name inside the captures directory. */
export function captureFileUri(fileName: string): string {
  return new File(capturesDirectory(), fileName).uri;
}
