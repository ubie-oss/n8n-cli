import type { ServerMiddleware, ServerMiddlewareFactory } from "./types.ts";

/**
 * In-process registry of server-middleware factories. Builtins register
 * themselves via `registerBuiltins` (called from cli/middleware-wiring);
 * tests can register fakes directly for isolation.
 *
 * The registry is intentionally a singleton: there is one CLI process per
 * invocation, and middleware identities ("lint", "authz") are inherently
 * global names. Per-test pollution is avoided via `resetRegistry` in
 * test helpers.
 */
const factories = new Map<string, ServerMiddlewareFactory<unknown>>();

export function registerFactory<O>(factory: ServerMiddlewareFactory<O>): void {
  factories.set(factory.name, factory as ServerMiddlewareFactory<unknown>);
}

export function getFactory(name: string): ServerMiddlewareFactory<unknown> | undefined {
  return factories.get(name);
}

export function knownMiddlewareNames(): string[] {
  return Array.from(factories.keys());
}

export function resetRegistry(): void {
  factories.clear();
}

export interface BuildMiddlewaresInput {
  /** Enabled middleware names, ordered. */
  enabled: string[];
  /** Raw env, defaults to process.env when omitted. */
  env?: NodeJS.ProcessEnv;
  /** Flat commander-style options bag from the CLI action. */
  cliOpts?: Record<string, unknown>;
}

/**
 * Resolves and builds the enabled middlewares.
 *
 * Order: built-in default values < env < CLI flags. The factory's
 * `loadFromEnv` and `loadFromCLI` each return *partial* options; this
 * function merges them with CLI winning on overlap, then hands the merged
 * object to `build`, which enforces required fields via zod.
 *
 * Unknown middleware names throw with a friendly list so users can't
 * silently disable the pipeline by typoing a name in env.
 */
export function buildMiddlewares(input: BuildMiddlewaresInput): ServerMiddleware[] {
  const env = input.env ?? process.env;
  const cliOpts = input.cliOpts ?? {};
  const built: ServerMiddleware[] = [];
  for (const name of input.enabled) {
    const factory = factories.get(name);
    if (!factory) {
      const known = Array.from(factories.keys()).sort().join(", ") || "(none registered)";
      throw new Error(
        `Unknown server middleware "${name}". Known: ${known}. ` +
          "Did you typo --server-middleware or N8N_SERVER_MIDDLEWARES?",
      );
    }
    const fromEnv = factory.loadFromEnv(env);
    const fromCli = factory.loadFromCLI(cliOpts);
    // Deep-merge per top-level key so partial CLI overrides don't wipe
    // env-supplied fields inside nested option buckets (e.g. when a user
    // sets N8N_AUTHZ_GROUPS_URL + N8N_AUTHZ_GROUPS_EXTRACT via env and then
    // overrides only --authz-groups-url on the CLI, the extract field
    // must survive). One level of nesting is enough for current options;
    // arrays are replaced wholesale (intended: a CLI list overrides env).
    const merged = mergeOptions(
      fromEnv as Record<string, unknown>,
      fromCli as Record<string, unknown>,
    );
    built.push(factory.build(merged));
  }
  return built;
}

function mergeOptions(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, ovValue] of Object.entries(override)) {
    if (ovValue === undefined) continue;
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(ovValue)) {
      out[key] = { ...baseValue, ...ovValue };
    } else {
      out[key] = ovValue;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses a comma- or whitespace-separated middleware list. Empty input
 * yields an empty array — callers default in.
 */
export function parseMiddlewareList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolves the active middleware list from CLI/env with a fallback default.
 *
 * Precedence:
 *   1. `cliValue` (e.g. commander's --server-middleware) when non-empty
 *   2. `env[envVar]` when non-empty
 *   3. `fallback` (typically ["lint"] for backwards compatibility)
 */
export function resolveEnabledList(args: {
  cliValue?: string;
  env?: NodeJS.ProcessEnv;
  envVar?: string;
  fallback: string[];
}): string[] {
  const fromCli = parseMiddlewareList(args.cliValue);
  if (fromCli.length > 0) return fromCli;
  const envVal = args.envVar ? args.env?.[args.envVar] : undefined;
  const fromEnv = parseMiddlewareList(envVal);
  if (fromEnv.length > 0) return fromEnv;
  return args.fallback;
}
