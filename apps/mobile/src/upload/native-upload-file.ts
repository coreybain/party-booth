/**
 * The plain file descriptor React Native's native FormData implementation expects.
 *
 * UploadThing reads the web-like metadata while requesting a presigned URL, then
 * detects `uri` and gives native FormData only `{ uri, type, name }` for the byte
 * transfer. Building a browser `File` first is both unnecessary and unreliable in
 * an iOS release bundle: it makes React Native read the local file through Blob and
 * can fail before the request reaches our `/api/uploadthing` route.
 */
export type NativeUploadFile = File & { readonly uri: string };

export function toNativeUploadFile(file: {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
}): NativeUploadFile {
  return {
    uri: file.uri,
    name: file.name,
    type: file.mimeType,
    size: file.byteSize,
    // Camera files do not expose this value and UploadThing only uses it as
    // optional file metadata/key entropy. Keep it deterministic across retries.
    lastModified: 0,
  } as NativeUploadFile;
}
