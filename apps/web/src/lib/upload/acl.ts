import { serverEnv } from "@partybooth/env/server";

export type UploadAcl = "private" | "public-read";

/**
 * Resolve the storage ACL from its dedicated setting. It deliberately does not
 * infer storage privacy from `DEPLOYMENT_ENVIRONMENT`: a staging deployment can
 * exercise either provider tier, while an unset ACL still fails closed to the
 * schema's `private` default.
 */
export function resolveUploadAcl(requested: UploadAcl): UploadAcl {
  return requested;
}

export function configuredUploadAcl(): UploadAcl {
  return resolveUploadAcl(serverEnv.UPLOADTHING_ACL);
}
