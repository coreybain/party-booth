import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAppError, appErrorMessage } from "./app-errors";
import { JOIN_API_PATH, requestJoin, requestPreviewByCode } from "./join-transport";

function respondWith(body: unknown, init: ResponseInit = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), init)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestJoin", () => {
  it("posts to the route handler rather than the Convex socket", async () => {
    // The whole point: only something in the request path can derive the
    // network key, so the browser must not be able to skip it.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: null }), {}),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestJoin({ via: "code", code: "482913" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JOIN_API_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "join",
      invite: { via: "code", code: "482913" },
    });
  });

  it("passes a well-formed result through", async () => {
    respondWith({
      ok: true,
      result: {
        outcome: "joined",
        eventId: "e1",
        membershipId: "m1",
        role: "guest",
        alreadyMember: false,
      },
    });
    await expect(requestJoin({ via: "code", code: "482913" })).resolves.toMatchObject({
      outcome: "joined",
      eventId: "e1",
    });
  });

  it("fails closed on an unparseable payload", async () => {
    // An unparseable answer must never be a third, distinguishable outcome —
    // that is a shape an enumeration oracle is built out of.
    respondWith({ ok: true, result: { outcome: "definitely-in" } });
    expect((await requestJoin({ via: "code", code: "482913" })).outcome).toBe("rejected");
  });

  it("rethrows a backend error as something the UI can render", async () => {
    respondWith({
      ok: false,
      error: { code: "accountLocked", message: "Your account is locked." },
    });
    await expect(requestJoin({ via: "code", code: "482913" })).rejects.toBeInstanceOf(
      RemoteAppError,
    );
    await requestJoin({ via: "code", code: "482913" }).catch((error: unknown) => {
      expect(appErrorMessage(error)).toBe("Your account is locked.");
    });
  });

  it("turns a dropped connection into party-Wi-Fi copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await requestJoin({ via: "token", token: "A".repeat(32) }).catch((error: unknown) => {
      expect(appErrorMessage(error)).toMatch(/offline/i);
    });
  });
});

describe("requestPreviewByCode", () => {
  it("returns the preview when there is one", async () => {
    respondWith({ ok: true, result: { eventId: "e1", name: "Summer party" } });
    expect(await requestPreviewByCode("482913")).toMatchObject({ name: "Summer party" });
  });

  it("gives one null for every kind of miss", async () => {
    for (const result of [null, 0, "nope", { name: "no id" }]) {
      respondWith({ ok: true, result });
      expect(await requestPreviewByCode("482913")).toBeNull();
    }
  });
});
