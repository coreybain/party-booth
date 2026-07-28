#!/usr/bin/env node
/**
 * seed:demo — create the App Review demo party in a Convex deployment.
 *
 *   pnpm seed:demo                            # rows with no thumbnails
 *   pnpm seed:demo key_abc123 key_def456      # rows pointing at real objects
 *   pnpm seed:demo --prod key_abc123          # against the production deployment
 *
 * It is a thin wrapper around `npx convex run`, and that is the whole design:
 * the seeder itself is an `internalMutation` in `packages/backend/convex/demo.ts`
 * where it is transactional and unit-tested offline, and this file only decides
 * which deployment to point it at. Releases and deploys are the owner's
 * (CONTRIBUTING: "no `convex deploy` ... from an agent or a CI job"), and so is
 * running this.
 *
 * It refuses to run unless DEMO_LOGIN_EMAIL and DEMO_LOGIN_OTP are set on the
 * *deployment* — the mutation checks, not this script — so a deployment that
 * never opted into the demo account cannot acquire a fake party by accident.
 *
 * Zero dependencies, like `env-doctor.mjs`, so it works before any install.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = resolve(ROOT, "packages/backend");

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const assetKeys = args.filter((arg) => !arg.startsWith("--"));

const payload = JSON.stringify(assetKeys.length > 0 ? { assetKeys } : {});

console.log(
  `Seeding the App Review demo party on the ${prod ? "production" : "development"} deployment…`,
);
if (assetKeys.length === 0) {
  console.log(
    "No asset keys given, so the demo media rows will have no thumbnails.\n" +
      "Upload two or three innocuous images to the UploadThing app once and pass\n" +
      "their keys: pnpm seed:demo key_one key_two key_three",
  );
}

const result = spawnSync(
  "npx",
  ["convex", "run", ...(prod ? ["--prod"] : []), "demo:seedDemoEvent", payload],
  { cwd: BACKEND, stdio: "inherit" },
);

if (result.error) {
  console.error(`Could not run the Convex CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
