#!/usr/bin/env bun
/**
 * verify:app-links — prove that a deployment actually serves the two documents
 * that make a printed QR open the app.
 *
 *   bun run verify:app-links                      # uses SITE_URL / NEXT_PUBLIC_SITE_URL
 *   bun run verify:app-links https://partybooth.app
 *
 * Why a script and not a test: the association files are the one part of the
 * deep-link chain that no unit test can reach. `app.config.ts` declares
 * `applinks:<host>` and an `autoVerify` intent filter, `expo prebuild` is happy,
 * the app installs — and the QR still opens Safari, because the *site* half of
 * the association was never served. Both platforms fetch these once at install
 * time and cache the answer, so the check has to happen against the real domain
 * before signage is printed (TODO.md, Sprint 7 → "Print QR signage").
 *
 * Checks, per URL:
 *   - HTTP 200 (a 404 means the deployment has no APPLE_TEAM_ID /
 *     ANDROID_CERT_FINGERPRINTS — the routes fail closed on purpose)
 *   - Content-Type: application/json (iOS rejects anything else, and the Apple
 *     file has no extension so a misconfigured host loves to send text/plain)
 *   - the document names the expected app and claims /join
 *
 * Zero dependencies, no build step. Exit code 1 if anything is wrong.
 */

const APPLE_PATH = "/.well-known/apple-app-site-association";
const ANDROID_PATH = "/.well-known/assetlinks.json";

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (colour ? `[31m${s}[0m` : s);
const green = (s) => (colour ? `[32m${s}[0m` : s);
const dim = (s) => (colour ? `[2m${s}[0m` : s);

const origin = (
  process.argv[2] ??
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  ""
).replace(/\/+$/, "");

if (!origin) {
  console.error(
    red("No origin."),
    "Pass one (`bun run verify:app-links https://partybooth.app`) or set SITE_URL.",
  );
  process.exit(1);
}

const failures = [];

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ${green("ok")}   ${label}`);
    return;
  }
  console.log(`  ${red("fail")} ${label}${detail ? ` ${dim(`— ${detail}`)}` : ""}`);
  failures.push(label);
}

async function fetchDocument(path) {
  const url = `${origin}${path}`;
  console.log(`\n${url}`);
  let response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch (error) {
    check(`${path} reachable`, false, String(error));
    return null;
  }

  check(`${path} → 200`, response.status === 200, `got ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  // iOS refuses anything that is not application/json, and this file has no
  // extension — so a host guessing by extension serves it as text/plain.
  check(`${path} is application/json`, type.includes("application/json"), `got "${type}"`);

  if (response.status !== 200) return null;
  try {
    return await response.json();
  } catch (error) {
    check(`${path} is valid JSON`, false, String(error));
    return null;
  }
}

const apple = await fetchDocument(APPLE_PATH);
if (apple) {
  const details = apple?.applinks?.details ?? [];
  const appIDs = details.flatMap((entry) => entry.appIDs ?? []);
  check("apple: at least one appID", appIDs.length > 0);
  check(
    "apple: appID looks like TEAMID.bundleid",
    appIDs.every((id) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(id)),
    appIDs.join(", "),
  );
  const paths = details.flatMap((entry) => (entry.components ?? []).map((c) => c["/"]));
  check("apple: claims /join/*", paths.includes("/join/*"), paths.join(", "));
  // A greedy claim would hijack the organiser console and /admin on any phone
  // with the app installed.
  check(
    "apple: claims nothing outside /join",
    paths.every((path) => typeof path === "string" && path.startsWith("/join")),
    paths.join(", "),
  );
}

const android = await fetchDocument(ANDROID_PATH);
if (android) {
  const statements = Array.isArray(android) ? android : [];
  check("android: is a statement list", statements.length > 0);
  const handlesUrls = statements.some((s) =>
    (s.relation ?? []).includes("delegate_permission/common.handle_all_urls"),
  );
  check("android: delegates handle_all_urls", handlesUrls);
  const fingerprints = statements.flatMap((s) => s.target?.sha256_cert_fingerprints ?? []);
  check("android: has a SHA-256 fingerprint", fingerprints.length > 0);
  check(
    "android: fingerprints are 32 hex pairs",
    fingerprints.every((f) => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(f)),
    fingerprints.join(", "),
  );
  const packages = statements.map((s) => s.target?.package_name).filter(Boolean);
  check("android: names a package", packages.length > 0, packages.join(", "));
}

console.log("");
if (failures.length > 0) {
  console.error(
    red(`${failures.length} problem${failures.length === 1 ? "" : "s"}.`),
    "Universal links will fall back to the mobile web page — which works, but the app will not open from the QR.",
  );
  process.exit(1);
}
console.log(green("Both association documents look right."));
