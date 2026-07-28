import { describe, expect, it } from "vitest";

import { isNavItemActive, ORGANISER_NAV } from "./organiser-nav";

/**
 * Exactly one tab lights up on every route the console serves. Zero looks
 * broken; two looks wrong; and both are easy to reintroduce by adding a route.
 */

const item = (href: string) => {
  const found = ORGANISER_NAV.find((entry) => entry.href === href);
  if (!found) throw new Error(`No nav item for ${href}`);
  return found;
};

const ROUTES = [
  "/dashboard",
  "/events",
  "/events/evt_1",
  "/events/evt_1/edit",
  "/events/new",
  "/slideshow",
  "/media",
  "/settings",
];

describe("isNavItemActive", () => {
  it("lights exactly one tab on every organiser route", () => {
    for (const pathname of ROUTES) {
      const active = ORGANISER_NAV.filter((entry) => isNavItemActive(entry, pathname));
      expect(active, pathname).toHaveLength(1);
    }
  });

  it("keeps Home lit while the host is inside one of their events", () => {
    for (const pathname of ["/events", "/events/evt_1", "/events/evt_1/edit", "/events/new"]) {
      expect(isNavItemActive(item("/dashboard"), pathname), pathname).toBe(true);
    }
  });

  it("does not match on a shared prefix that is a different route", () => {
    // `/mediation` is not `/media`.
    expect(isNavItemActive(item("/media"), "/mediation")).toBe(false);
  });
});
