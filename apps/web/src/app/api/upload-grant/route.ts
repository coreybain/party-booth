import { toAppErrorView } from "@/lib/app-errors";
import { fetchAuthMutation } from "@/lib/auth-server";
import { uploadGrantRequestSchema } from "@/lib/contracts";
import { backendApi } from "@/lib/convex-api";

import type { UploadGrantApiResponse } from "@/lib/upload/grant-transport";

/**
 * `POST /api/upload-grant` — an authenticated, non-reactive grant request.
 *
 * `fetchAuthMutation` exchanges the first-party session cookie for the same
 * Convex identity the browser socket uses. Every permission, event-state,
 * throttle, file-policy and audit check remains inside `media.requestUploadGrant`;
 * this route changes only the transport used to receive its result.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(body: UploadGrantApiResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!fetchAuthMutation) {
    return json(
      {
        ok: false,
        error: {
          code: "unknown",
          message: "The backend is not configured yet, so uploads are unavailable.",
        },
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const parsed = uploadGrantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: { code: "invalidInput", message: "That upload is not valid." },
      },
      400,
    );
  }

  try {
    const result = await fetchAuthMutation(backendApi.media.requestUploadGrant, parsed.data);
    return json({ ok: true, result }, 200);
  } catch (error) {
    return json({ ok: false, error: toAppErrorView(error) }, 400);
  }
}
