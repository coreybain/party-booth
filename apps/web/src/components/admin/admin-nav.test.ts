import { describe, expect, it } from "vitest";

import { ADMIN_NAV, isAdminNavItemActive } from "./admin-nav";

/**
 * `/admin` is a prefix of every other route in the console, so the overview tab
 * is the one that gets this wrong: `startsWith("/admin")` lights it on all four
 * pages. Exactly one tab lights up, always — zero looks broken and two looks
 * like a bug in something more important than a nav.
 */
const ROUTES = ["/admin", "/admin/accounts", "/admin/events", "/admin/audit"];

describe("isAdminNavItemActive", () => {
  it("lights exactly one tab on every console route", () => {
    for (const pathname of ROUTES) {
      const active = ADMIN_NAV.filter((item) => isAdminNavItemActive(item.href, pathname));
      expect(
        active.map((item) => item.href),
        pathname,
      ).toHaveLength(1);
    }
  });

  it("does not light the overview from a sub-route", () => {
    expect(isAdminNavItemActive("/admin", "/admin/accounts")).toBe(false);
    expect(isAdminNavItemActive("/admin", "/admin")).toBe(true);
  });

  it("keeps `/admin/login` out of the console nav entirely", () => {
    // The login page renders outside the `(console)` layout on purpose — it has
    // to be reachable while signed out — so no tab should claim it.
    expect(ADMIN_NAV.filter((item) => isAdminNavItemActive(item.href, "/admin/login"))).toEqual([]);
  });
});
