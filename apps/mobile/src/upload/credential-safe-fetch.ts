/**
 * UploadThing logs its complete request input when `fetch` throws. Mobile uploads
 * explicitly forward the Better Auth cookie, so that diagnostic would disclose a
 * live session credential in Metro. Convert transport exceptions into a small,
 * ordinary HTTP failure before UploadThing reaches that logging branch.
 */
export const credentialSafeUploadFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    return new Response(JSON.stringify({ message: "The upload service is unreachable." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
};
