import { afterEach, describe, expect, it, vi } from "vitest";

import { credentialSafeUploadFetch } from "./credential-safe-fetch";

describe("credentialSafeUploadFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes successful requests through unchanged", async () => {
    const response = new Response("ok", { status: 200 });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);

    await expect(
      credentialSafeUploadFetch("https://uploads.example.test", {
        headers: { cookie: "private" },
      }),
    ).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns a credential-free HTTP failure when native fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const response = await credentialSafeUploadFetch("https://uploads.example.test", {
      headers: { cookie: "better-auth.session_token=private" },
      body: JSON.stringify({ secret: "avatar-grant-private" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "The upload service is unreachable." });
  });
});
