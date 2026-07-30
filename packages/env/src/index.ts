/**
 * `@partybooth/env` — typed, lazily-validated environment access.
 *
 * Import from the narrowest entry point you can:
 *
 * - `@partybooth/env/server` — server / Convex only (throws if read in a browser)
 * - `@partybooth/env/client` — `apps/web` browser code (`NEXT_PUBLIC_*`)
 * - `@partybooth/env/mobile` — `apps/mobile` (`EXPO_PUBLIC_*`)
 *
 * This barrel re-exports the primitives and the schema only. It deliberately
 * does **not** re-export `serverEnv`, so importing it from client code cannot
 * pull server secrets into a bundle.
 */
export {
  createEnv,
  describeEnv,
  envAssert,
  envHas,
  envHasAll,
  envIsSet,
  envKeys,
  envOptional,
  EnvError,
  envVar,
  InvalidEnvError,
  MissingEnvError,
  resetEnvCache,
  ServerEnvAccessError,
  type CreateEnvOptions,
  type EnvDefinition,
  type EnvVarReport,
  type EnvVarSpec,
  type InferEnv,
  type RuntimeEnv,
} from "./create-env";

export {
  clientVars,
  mobileVars,
  serverVars,
  STORAGE_REGIONS,
  type ClientVars,
  type MobileVars,
  type ServerVars,
  type StorageRegion,
} from "./schema";
