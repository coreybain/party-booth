import { redirect } from "next/navigation";

import { fetchAuthMutation } from "@/lib/auth-server";
import { backendApi } from "@/lib/convex-api";

export const dynamic = "force-dynamic";

export default async function CompleteOrganiserInvitationPage() {
  if (!fetchAuthMutation) redirect("/host?invite=invalid");

  try {
    const result = await fetchAuthMutation(backendApi.users.refreshRoles, {});
    redirect(result.isOrganiser ? "/events" : "/host?needs=invitation");
  } catch {
    redirect("/host?invite=invalid");
  }
}
