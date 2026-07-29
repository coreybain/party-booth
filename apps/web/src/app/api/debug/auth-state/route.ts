// #region DEBUG
import { mkdir, appendFile } from "node:fs/promises";

import { envOptional, serverEnv } from "@partybooth/env/server";

import { isAuthenticated } from "@/lib/auth-server";

const DEBUG_DIRECTORY = "/Users/coreybaines/GitHub/partybooth/.codex/logs";
const DEBUG_LOG = "/Users/coreybaines/GitHub/partybooth/.codex/logs/debug.log";

function hostOf(value: string | undefined): string {
  if (value === undefined) return "unset";
  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const serverHasSession = await isAuthenticated();
  const serverConvexHost = hostOf(envOptional(serverEnv, "CONVEX_URL"));
  const serverSiteHost = hostOf(envOptional(serverEnv, "CONVEX_SITE_URL"));

  const line = [
    `[DEBUG H1 timing] at=${Date.now()}`,
    `convexLoading=${String(body.convexLoading)}`,
    `convexAuthenticated=${String(body.convexAuthenticated)}`,
    `[DEBUG H4 backend-identity] state=${String(body.backendIdentity)}`,
    `[DEBUG H2 session] betterAuthPending=${String(body.betterAuthPending)}`,
    `betterAuthHasSession=${String(body.betterAuthHasSession)}`,
    `serverHasSession=${String(serverHasSession)}`,
    `[DEBUG H3 deployment] clientConvexHost=${String(body.clientConvexHost)}`,
    `serverConvexHost=${serverConvexHost}`,
    `serverSiteHost=${serverSiteHost}`,
  ].join(" ");

  await mkdir(DEBUG_DIRECTORY, { recursive: true });
  await appendFile(DEBUG_LOG, `${line}\n`, "utf8");

  return new Response(null, { status: 204 });
}
// #endregion DEBUG
