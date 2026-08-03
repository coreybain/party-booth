import { SIGNED_READ_URL_TTL_SECONDS } from "@partybooth/contracts";
import { resetEnvCache } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveStorageAdapter,
  setStorageAdapterOverride,
  StorageNotConfiguredError,
  unconfiguredAdapter,
} from "./lib/storage";
import { createFakeStorageAdapter } from "./lib/storage/fake";

/**
 * The storage seam, tested directly.
 *
 * `media.test.ts` proves the *pipeline* — a withdrawn file leaves the record
 * with nothing that names an object — by watching what lands in the database.
 * These tests prove the seam itself: that a region resolves to the right
 * adapter, that a missing token degrades the way the read paths assume, and
 * that the fake behaves enough like a provider for those tests to mean
 * something.
 */

const NOW = 1_800_000_000_000;

function setToken(value: string | undefined): void {
  if (value === undefined) {
    delete process.env["UPLOADTHING_TOKEN"];
  } else {
    process.env["UPLOADTHING_TOKEN"] = value;
  }
  resetEnvCache(serverEnv);
}

afterEach(() => {
  setStorageAdapterOverride(undefined);
  setToken(undefined);
  delete process.env["UPLOADTHING_ACL"];
  delete process.env["UPLOADTHING_APP_ID"];
  delete process.env["DEPLOYMENT_ENVIRONMENT"];
  resetEnvCache(serverEnv);
});

describe("resolveStorageAdapter", () => {
  it("degrades to a loud, unconfigured adapter with no credentials", async () => {
    const adapter = resolveStorageAdapter("pdx1");
    expect(adapter.provider).toBe("unconfigured");
    expect(adapter.configured).toBe(false);
    expect(adapter.describe()).toEqual({
      region: "pdx1",
      provider: "unconfigured",
      configured: false,
    });

    await expect(adapter.createReadUrl("k")).rejects.toBeInstanceOf(StorageNotConfiguredError);
    await expect(adapter.deleteFiles(["k"])).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it("resolves to UploadThing once a token exists, without loading the SDK", () => {
    setToken("ut_v7_token_that_is_not_real");
    const adapter = resolveStorageAdapter("pdx1");
    // Constructing the adapter must not touch `uploadthing/server`: the import
    // is deliberately lazy so that an offline test run — and a deployment with
    // no token — never evaluates the provider SDK at all.
    expect(adapter.provider).toBe("uploadthing");
    expect(adapter.configured).toBe(true);
    expect(adapter.region).toBe("pdx1");
  });

  it("uses the public file URL whenever the dedicated ACL requests it", async () => {
    setToken("ut_v7_token_that_is_not_real");
    process.env["UPLOADTHING_ACL"] = "public-read";
    process.env["UPLOADTHING_APP_ID"] = "freeapp123";
    process.env["DEPLOYMENT_ENVIRONMENT"] = "production";
    resetEnvCache(serverEnv);

    const result = await resolveStorageAdapter("pdx1").createReadUrl("file key", {
      expiresInSeconds: 60,
    });

    expect(result.url).toBe("https://freeapp123.ufs.sh/f/file%20key");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("uses the token app id when a stale standalone id disagrees", async () => {
    setToken(
      btoa(JSON.stringify({ apiKey: "not-real", appId: "token-app-123", regions: ["pdx1"] })),
    );
    process.env["UPLOADTHING_ACL"] = "public-read";
    process.env["UPLOADTHING_APP_ID"] = "stale-app-456";
    resetEnvCache(serverEnv);

    const result = await resolveStorageAdapter("pdx1").createReadUrl("new-file-key");

    expect(result.url).toBe("https://token-app-123.ufs.sh/f/new-file-key");
  });

  it("carries the region it was asked for, not the environment default", () => {
    // One region today. The assertion exists because ADR 0002's whole promise is
    // that the *row* decides — `media.storageRegion` for a read, never
    // `STORAGE_DEFAULT_REGION`, which only ever seeds a new event.
    expect(resolveStorageAdapter("pdx1").region).toBe("pdx1");
    expect(unconfiguredAdapter("pdx1").describe().region).toBe("pdx1");
  });

  it("honours a test override for every region", () => {
    const fake = createFakeStorageAdapter();
    setStorageAdapterOverride(() => fake);
    expect(resolveStorageAdapter("pdx1")).toBe(fake);

    setStorageAdapterOverride(undefined);
    expect(resolveStorageAdapter("pdx1").provider).toBe("unconfigured");
  });
});

describe("the fake adapter", () => {
  it("mints a URL bound to the key, that expires", async () => {
    const fake = createFakeStorageAdapter({ now: () => NOW });

    const a = await fake.createReadUrl("key-a");
    const b = await fake.createReadUrl("key-b");

    expect(a.expiresAt).toBe(NOW + SIGNED_READ_URL_TTL_SECONDS * 1000);
    expect(a.url).toContain("key-a");
    expect(a.url).not.toBe(b.url);

    const short = await fake.createReadUrl("key-a", { expiresInSeconds: 30 });
    expect(short.expiresAt).toBe(NOW + 30_000);
  });

  it("deletes what it holds and reports what it did", async () => {
    const fake = createFakeStorageAdapter();
    fake.put("one");
    fake.put("two");
    expect(fake.keys()).toEqual(["one", "two"]);

    expect(await fake.deleteFiles(["one"])).toEqual({ success: true, deleted: 1 });
    expect(fake.has("one")).toBe(false);
    expect(fake.has("two")).toBe(true);
    expect(fake.deleteCalls()).toEqual([["one"]]);
  });

  it("treats deleting something already gone as a success", async () => {
    // Withdrawal must not be able to fail permanently on a retry.
    const fake = createFakeStorageAdapter();
    expect(await fake.deleteFiles(["never-existed"])).toEqual({ success: true, deleted: 0 });
    expect(await fake.deleteFiles([])).toEqual({ success: true, deleted: 0 });
  });

  it("can resolve without confirming a delete", async () => {
    const fake = createFakeStorageAdapter({ refuseDeletes: true });
    fake.put("still-there");
    expect(await fake.deleteFiles(["still-there"])).toEqual({ success: false, deleted: 0 });
    expect(fake.has("still-there")).toBe(true);
  });

  it("can be made to fail reads, for the degrade-don't-crash paths", async () => {
    const fake = createFakeStorageAdapter({ failReads: true });
    await expect(fake.createReadUrl("k")).rejects.toThrow(/reads are failing/);
  });
});
