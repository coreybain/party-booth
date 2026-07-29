/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

const { getSentryExpoConfig } = require("@sentry/react-native/metro");

/**
 * Metro configuration for apps/mobile inside the Bun workspace.
 *
 * `getSentryExpoConfig` is a drop-in superset of `expo/metro-config`'s
 * `getDefaultConfig`: it adds the debug-id/source-map plumbing Sentry needs. It is safe
 * to use with no DSN and no auth token — it simply produces the same bundle plus source
 * maps that never get uploaded.
 *
 * `watchFolders` must include the workspace root so edits in `packages/*` trigger a
 * Fast Refresh. Hierarchical lookup is deliberately left enabled because the workspace
 * uses `linker = "hoisted"` (see package.json) — every dependency is resolvable
 * from the root `node_modules`.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getSentryExpoConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
