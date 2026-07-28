import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Base class for every problem this package reports. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** A variable that the code just tried to read is not set anywhere. */
export class MissingEnvError extends EnvError {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "MissingEnvError";
    this.key = key;
  }
}

/** A variable is set but does not match its schema. */
export class InvalidEnvError extends EnvError {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "InvalidEnvError";
    this.key = key;
  }
}

/** A server-only variable was read from code running in a browser/app bundle. */
export class ServerEnvAccessError extends EnvError {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "ServerEnvAccessError";
    this.key = key;
  }
}

/* -------------------------------------------------------------------------- */
/* Definitions                                                                 */
/* -------------------------------------------------------------------------- */

export interface EnvVarSpec<TSchema extends z.ZodType = z.ZodType> {
  /** Zod schema. If it accepts `undefined`, the variable is optional. */
  readonly schema: TSchema;
  /** One line telling Corey exactly where the value comes from. */
  readonly hint: string;
  /** Never print the value in diagnostics. */
  readonly secret: boolean;
}

/**
 * Declare one environment variable.
 *
 * @example
 * const vars = {
 *   RESEND_API_KEY: envVar(z.string().min(1), "Resend dashboard → API Keys", { secret: true }),
 * } as const;
 */
export function envVar<TSchema extends z.ZodType>(
  schema: TSchema,
  hint: string,
  options: { readonly secret?: boolean } = {},
): EnvVarSpec<TSchema> {
  return { schema, hint, secret: options.secret ?? false };
}

export type EnvDefinition = Readonly<Record<string, EnvVarSpec>>;

export type InferEnv<TDefinition extends EnvDefinition> = {
  readonly [K in keyof TDefinition]: z.output<TDefinition[K]["schema"]>;
};

export type RuntimeEnv<TDefinition extends EnvDefinition> = Readonly<
  Partial<Record<keyof TDefinition & string, string | undefined>>
>;

export interface CreateEnvOptions<TDefinition extends EnvDefinition> {
  /** Human label used in error messages, e.g. `"server"` or `"web client"`. */
  readonly id: string;
  readonly vars: TDefinition;
  /**
   * Explicit map of raw values. Must be an object literal of
   * `process.env.SOME_KEY` reads so that bundlers (Next.js, Metro) can inline
   * public variables — a `Proxy` over `process.env` does not survive bundling.
   */
  readonly runtimeEnv: RuntimeEnv<TDefinition>;
  /**
   * When true, every read throws {@link ServerEnvAccessError}. Used to stop
   * server-only values from being read in a browser bundle.
   */
  readonly serverOnly?: boolean;
  /** Where a human should put the value. Shown in every error. */
  readonly source?: string;
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                     */
/* -------------------------------------------------------------------------- */

type Resolution =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: EnvError };

interface EnvRuntimeState {
  readonly id: string;
  readonly vars: EnvDefinition;
  readonly runtimeEnv: Readonly<Record<string, string | undefined>>;
  readonly serverOnly: boolean;
  readonly source: string;
  readonly cache: Map<string, Resolution>;
}

const REGISTRY = new WeakMap<object, EnvRuntimeState>();

const DEFAULT_SOURCE = ".env.local at the repo root (copy .env.example)";

/**
 * Detect a browser/app bundle without depending on DOM lib types — this package
 * is compiled with Node libs so it can be imported from Convex too.
 */
function isBrowser(): boolean {
  const candidate = globalThis as { window?: { document?: unknown } };
  return candidate.window?.document !== undefined;
}

function readRaw(state: EnvRuntimeState, key: string): string | undefined {
  const raw = state.runtimeEnv[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // An empty variable is the same as an unset one; `FOO=` is a common accident.
  return trimmed === "" ? undefined : trimmed;
}

function isOptional(spec: EnvVarSpec): boolean {
  return spec.schema.safeParse(undefined).success;
}

function resolve(state: EnvRuntimeState, key: string): Resolution {
  const cached = state.cache.get(key);
  if (cached) return cached;

  const spec = state.vars[key];
  if (!spec) {
    const result: Resolution = {
      ok: false,
      error: new EnvError(
        `[@partybooth/env] "${key}" is not declared in the ${state.id} environment. ` +
          `Add it to packages/env/src/schema.ts and to .env.example.`,
      ),
    };
    state.cache.set(key, result);
    return result;
  }

  if (state.serverOnly && isBrowser()) {
    const result: Resolution = {
      ok: false,
      error: new ServerEnvAccessError(
        key,
        `[@partybooth/env] "${key}" is a server-only variable and was read from browser code. ` +
          `Move the read into a server component, route handler or Convex function — or, if the ` +
          `value is genuinely public, expose it as NEXT_PUBLIC_*/EXPO_PUBLIC_* instead.`,
      ),
    };
    state.cache.set(key, result);
    return result;
  }

  const raw = readRaw(state, key);
  const parsed = spec.schema.safeParse(raw);

  if (parsed.success) {
    const result: Resolution = { ok: true, value: parsed.data };
    state.cache.set(key, result);
    return result;
  }

  const error =
    raw === undefined
      ? new MissingEnvError(
          key,
          [
            `[@partybooth/env] Missing required ${state.id} environment variable ${key}.`,
            `  Where it comes from: ${spec.hint}`,
            `  Set it in: ${state.source}`,
          ].join("\n"),
        )
      : new InvalidEnvError(
          key,
          [
            `[@partybooth/env] Invalid ${state.id} environment variable ${key}.`,
            z
              .prettifyError(parsed.error)
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n"),
            `  Where it comes from: ${spec.hint}`,
            `  Set it in: ${state.source}`,
          ].join("\n"),
        );

  const result: Resolution = { ok: false, error };
  state.cache.set(key, result);
  return result;
}

function stateOf(env: object): EnvRuntimeState {
  const state = REGISTRY.get(env);
  if (!state) {
    throw new EnvError("[@partybooth/env] Object was not produced by createEnv().");
  }
  return state;
}

/**
 * Build a lazily-validated environment accessor.
 *
 * Nothing is read or validated until a property is accessed, so a missing
 * variable only ever breaks the feature that actually needs it — importing the
 * module is always safe.
 */
export function createEnv<TDefinition extends EnvDefinition>(
  options: CreateEnvOptions<TDefinition>,
): InferEnv<TDefinition> {
  const state: EnvRuntimeState = {
    id: options.id,
    vars: options.vars,
    runtimeEnv: options.runtimeEnv as Readonly<Record<string, string | undefined>>,
    serverOnly: options.serverOnly ?? false,
    source: options.source ?? DEFAULT_SOURCE,
    cache: new Map(),
  };

  const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  const proxy = new Proxy(target, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const resolution = resolve(state, prop);
      if (!resolution.ok) throw resolution.error;
      return resolution.value;
    },
    has(_target, prop) {
      return typeof prop === "string" && prop in state.vars;
    },
    ownKeys() {
      return Object.keys(state.vars);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string" || !(prop in state.vars)) return undefined;
      return { enumerable: true, configurable: true };
    },
    set(_target, prop) {
      throw new EnvError(
        `[@partybooth/env] Environment values are read-only (tried to assign ${String(prop)}).`,
      );
    },
    deleteProperty(_target, prop) {
      throw new EnvError(
        `[@partybooth/env] Environment values are read-only (tried to delete ${String(prop)}).`,
      );
    },
  });

  REGISTRY.set(proxy, state);
  return proxy as InferEnv<TDefinition>;
}

/* -------------------------------------------------------------------------- */
/* Non-throwing helpers — for graceful degradation                             */
/* -------------------------------------------------------------------------- */

/**
 * Read a variable without throwing when it is missing. Returns `undefined` if
 * the value is unset. Still throws {@link InvalidEnvError} when the value is
 * present but malformed — a typo should never be silently ignored.
 */
export function envOptional<TEnv extends object, K extends keyof TEnv & string>(
  env: TEnv,
  key: K,
): TEnv[K] | undefined {
  const resolution = resolve(stateOf(env), key);
  if (resolution.ok) return resolution.value as TEnv[K];
  if (resolution.error instanceof MissingEnvError) return undefined;
  throw resolution.error;
}

/**
 * True when the variable is present and valid. Never throws — use this to gate
 * optional providers (Sentry, Resend, push) so the app degrades to a no-op.
 *
 * **`.ok` is not enough, and that was a real bug.** A spec declared
 * `schema.optional()` — which is every variable a feature flag would ever gate —
 * parses an *absent* value successfully, to `undefined`. So `resolve(…).ok` was
 * `true` for a variable nobody had set, and every `serverFeatures` flag reading
 * an optional variable was permanently on: `sentry` with no DSN, `expoPush` with
 * no Expo project. The gate has to ask about the **value**, which is what the
 * sentence above always claimed it did.
 *
 * A variable whose schema has a `.default()` is genuinely present — the default
 * is the value — and still answers `true`, which is right.
 */
export function envHas<TEnv extends object>(env: TEnv, key: keyof TEnv & string): boolean {
  const resolution = resolve(stateOf(env), key);
  return resolution.ok && resolution.value !== undefined;
}

/** True when every listed variable is present and valid. Never throws. */
export function envHasAll<TEnv extends object>(
  env: TEnv,
  keys: readonly (keyof TEnv & string)[],
): boolean {
  return keys.every((key) => envHas(env, key));
}

/**
 * Eagerly validate a subset of variables — call this at a boundary (route
 * handler, Convex action, app bootstrap) to fail with one aggregated message
 * instead of a cascade of individual throws.
 */
export function envAssert<TEnv extends object>(
  env: TEnv,
  keys: readonly (keyof TEnv & string)[],
): void {
  const state = stateOf(env);
  const problems: string[] = [];
  for (const key of keys) {
    const resolution = resolve(state, key);
    if (!resolution.ok) problems.push(resolution.error.message);
  }
  if (problems.length > 0) {
    throw new EnvError(
      `[@partybooth/env] ${problems.length} problem(s) with the ${state.id} environment:\n\n${problems.join("\n\n")}`,
    );
  }
}

export interface EnvVarReport {
  readonly key: string;
  readonly hint: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly present: boolean;
  readonly valid: boolean;
  readonly problem: string | undefined;
}

/**
 * Describe every declared variable and its current state. Values are never
 * included, so this is safe to log. See also `pnpm env:doctor`.
 */
export function describeEnv<TEnv extends object>(env: TEnv): readonly EnvVarReport[] {
  const state = stateOf(env);
  return Object.entries(state.vars).map(([key, spec]) => {
    const resolution = resolve(state, key);
    return {
      key,
      hint: spec.hint,
      required: !isOptional(spec),
      secret: spec.secret,
      present: readRaw(state, key) !== undefined,
      valid: resolution.ok,
      problem: resolution.ok ? undefined : resolution.error.message,
    };
  });
}

/** All declared variable names, in declaration order. */
export function envKeys<TEnv extends object>(env: TEnv): readonly string[] {
  return Object.keys(stateOf(env).vars);
}

/** Drop memoised results. Only needed in tests that mutate `process.env`. */
export function resetEnvCache<TEnv extends object>(env: TEnv): void {
  stateOf(env).cache.clear();
}
