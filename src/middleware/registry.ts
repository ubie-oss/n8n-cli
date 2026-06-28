import type { MiddlewareFactory, PreWriteMiddleware } from "./types.ts";

/**
 * In-process registry of middleware factories. Builtins register themselves
 * via `registerBuiltins` (called from cli/middleware-wiring); tests can
 * register fakes directly for isolation.
 *
 * The registry is intentionally a singleton: there is one CLI process per
 * invocation, and middleware identities ("lint", "authz") are inherently
 * global names. Per-test pollution is avoided via `resetRegistry` in
 * test helpers.
 */
const factories = new Map<string, MiddlewareFactory<unknown>>();

export function registerFactory<O>(factory: MiddlewareFactory<O>): void {
  factories.set(factory.name, factory as MiddlewareFactory<unknown>);
}

export function getFactory(name: string): MiddlewareFactory<unknown> | undefined {
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
export function buildMiddlewares(input: BuildMiddlewaresInput): PreWriteMiddleware[] {
  const env = input.env ?? process.env;
  const cliOpts = input.cliOpts ?? {};
  const built: PreWriteMiddleware[] = [];
  for (const name of input.enabled) {
    const factory = factories.get(name);
    if (!factory) {
      const known = Array.from(factories.keys()).sort().join(", ") || "(none registered)";
      throw new Error(
        `Unknown middleware "${name}". Known middlewares: ${known}. ` +
          "Did you typo --middleware or N8N_MIDDLEWARES?",
      );
    }
    const fromEnv = factory.loadFromEnv(env);
    const fromCli = factory.loadFromCLI(cliOpts);
    const merged = { ...fromEnv, ...fromCli };
    built.push(factory.build(merged));
  }
  return built;
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
 *   1. `cliValue` (e.g. commander's --middleware) when non-empty
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
