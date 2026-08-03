import { envIsSet, serverEnv } from "@partybooth/env/server";

export type UploadAcl = "private" | "public-read";

interface UploadAclEnvironment {
  readonly requested: UploadAcl;
  readonly deploymentEnvironment: "development" | "preview" | "production";
  readonly deploymentEnvironmentIsExplicit: boolean;
}

/**
 * Resolve the storage ACL without letting a missing deployment marker widen
 * access. UploadThing's free tier only accepts `public-read`, so local
 * development may opt into it explicitly; preview and production stay private.
 */
export function resolveUploadAcl(environment: UploadAclEnvironment): UploadAcl {
  if (environment.requested === "private") return "private";

  if (
    !environment.deploymentEnvironmentIsExplicit ||
    environment.deploymentEnvironment !== "development"
  ) {
    throw new Error(
      "UPLOADTHING_ACL=public-read is allowed only when DEPLOYMENT_ENVIRONMENT is explicitly set to development.",
    );
  }

  return "public-read";
}

export function configuredUploadAcl(): UploadAcl {
  return resolveUploadAcl({
    requested: serverEnv.UPLOADTHING_ACL,
    deploymentEnvironment: serverEnv.DEPLOYMENT_ENVIRONMENT,
    deploymentEnvironmentIsExplicit: envIsSet(serverEnv, "DEPLOYMENT_ENVIRONMENT"),
  });
}
