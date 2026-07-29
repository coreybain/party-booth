import { redirect } from "next/navigation";

import { fetchAuthMutation } from "@/lib/auth-server";
import { backendApi } from "@/lib/convex-api";

export const dynamic = "force-dynamic";

export default async function CompleteOrganiserInvitationPage() {
  if (!fetchAuthMutation) redirect("/?invite=invalid");

  try {
    const result = await fetchAuthMutation(backendApi.users.refreshRoles, {});
    redirect(result.isOrganiser ? "/dashboard" : "/?needs=invitation");
  } catch {
    redirect("/?invite=invalid");
  }
}
