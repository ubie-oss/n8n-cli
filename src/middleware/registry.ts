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
  /**
   * Per-middleware option sections from `.n8nctlrc.json`
   * (`middlewares.options`), keyed by middleware name. Merged at the lowest
   * precedence: file < env < CLI flags. Keys mirror the CLI option names.
   */
  fileOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Resolves and builds the enabled middlewares.
 *
 * Order: built-in default values < config file < env < CLI flags. The
 * factory's `loadFromCLI` doubles as the file-section parser (the sections
 * use the same camelCase keys the commander options bag carries), so a
 * factory needs no extra method to support the config file. Each loader
 * returns *partial* options; this function merges them with CLI winning on
 * overlap, then hands the merged object to `build`, which enforces required
 * fields via zod.
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
    const fileSection = input.fileOptions?.[name];
    const fromFile = fileSection ? factory.loadFromCLI(fileSection) : {};
    const fromEnv = factory.loadFromEnv(env);
    const fromCli = factory.loadFromCLI(cliOpts);
    // Deep-merge per top-level key so partial CLI overrides don't wipe
    // env-supplied fields inside nested option buckets (e.g. when a user
    // sets N8N_AUTHZ_GROUPS_URL + N8N_AUTHZ_GROUPS_EXTRACT via env and then
    // overrides only --authz-groups-url on the CLI, the extract field
    // must survive). One level of nesting is enough for current options;
    // arrays are replaced wholesale (intended: a CLI list overrides env).
    const merged = mergeOptions(
      mergeOptions(fromFile as Record<string, unknown>, fromEnv as Record<string, unknown>),
      fromCli as Record<string, unknown>,
    );
    built.push(factory.build(merged));
  }
  return built;
}

/**
 * Merges two partial option objects with `override` winning. Kept next to
 * buildMiddlewares; the two-arg shape composes for the file < env < CLI
 * chain.
 */
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
 * Resolves the active middleware list from CLI/env/config file with a
 * fallback default.
 *
 * Precedence:
 *   1. `cliValue` (e.g. commander's --server-middleware) when non-empty
 *   2. `env[envVar]` when non-empty
 *   3. `fileValue` (middlewares.server / middlewares.client in
 *      `.n8nctlrc.json`) when non-empty
 *   4. `fallback` (typically ["lint"] for backwards compatibility)
 */
export function resolveEnabledList(args: {
  cliValue?: string;
  env?: NodeJS.ProcessEnv;
  envVar?: string;
  fileValue?: string[];
  fallback: string[];
}): string[] {
  const fromCli = parseMiddlewareList(args.cliValue);
  if (fromCli.length > 0) return fromCli;
  const envVal = args.envVar ? args.env?.[args.envVar] : undefined;
  const fromEnv = parseMiddlewareList(envVal);
  if (fromEnv.length > 0) return fromEnv;
  if (args.fileValue && args.fileValue.length > 0) return args.fileValue;
  return args.fallback;
}
