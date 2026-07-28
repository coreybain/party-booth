import { describe, expect, it } from "vitest";

import { clientNetworkKey } from "./network-key";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("clientNetworkKey", () => {
  it("takes the client hop, not the proxy that forwarded it", () => {
    // Taking the last entry keys every visitor to the same edge node, which
    // turns a per-attacker throttle into a site-wide outage on party night.
    expect(
      clientNetworkKey(headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" })),
    ).toBe("203.0.113.7");
  });

  it("handles a single address and stray whitespace", () => {
    expect(clientNetworkKey(headers({ "x-forwarded-for": "  203.0.113.7 " }))).toBe("203.0.113.7");
  });

  it("supports IPv6, which is most mobile traffic", () => {
    expect(clientNetworkKey(headers({ "x-forwarded-for": "2001:db8::8a2e:370:7334" }))).toBe(
      "2001:db8::8a2e:370:7334",
    );
  });

  it("falls back through the other address headers in order", () => {
    expect(clientNetworkKey(headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientNetworkKey(headers({ "cf-connecting-ip": "198.51.100.5" }))).toBe("198.51.100.5");
    expect(
      clientNetworkKey(headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" })),
    ).toBe("203.0.113.7");
  });

  it("returns undefined rather than a junk key", () => {
    // `undefined` charges the attempt to the account key alone — the behaviour
    // before this existed. A key derived from garbage would be a key an
    // attacker can vary at will, which is worse than not having one.
    expect(clientNetworkKey(headers({}))).toBeUndefined();
    expect(clientNetworkKey(headers({ "x-forwarded-for": "" }))).toBeUndefined();
    expect(clientNetworkKey(headers({ "x-forwarded-for": " , 203.0.113.7" }))).toBeUndefined();
    expect(clientNetworkKey(headers({ "x-forwarded-for": "unknown" }))).toBeUndefined();
    expect(clientNetworkKey(headers({ "x-forwarded-for": "a".repeat(200) }))).toBeUndefined();
  });
});
