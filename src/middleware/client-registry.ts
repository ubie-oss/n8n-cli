import type { ClientMiddleware, ClientMiddlewareFactory } from "./types.ts";

/**
 * In-process registry of client-middleware factories. Mirrors `registry.ts`
 * (the server-side registry) but stays in its own module so the two
 * pipelines can be enabled/disabled independently.
 *
 * Singleton by design: one CLI process per invocation, identities are global.
 * Tests reset via `resetClientRegistry`.
 */
const factories = new Map<string, ClientMiddlewareFactory<unknown>>();

export function registerClientFactory<O>(factory: ClientMiddlewareFactory<O>): void {
  factories.set(factory.name, factory as ClientMiddlewareFactory<unknown>);
}

export function getClientFactory(name: string): ClientMiddlewareFactory<unknown> | undefined {
  return factories.get(name);
}

export function knownClientMiddlewareNames(): string[] {
  return Array.from(factories.keys());
}

export function resetClientRegistry(): void {
  factories.clear();
}

export interface BuildClientMiddlewaresInput {
  /** Enabled client middleware names, ordered. */
  enabled: string[];
  /** Raw env, defaults to process.env when omitted. */
  env?: NodeJS.ProcessEnv;
  /** Flat commander-style options bag from the CLI action. */
  cliOpts?: Record<string, unknown>;
}

/**
 * Resolves and builds the enabled client middlewares.
 *
 * Same precedence model as `buildMiddlewares`: env < CLI flags, with deep
 * merge per top-level key so partial CLI overrides don't wipe env-supplied
 * fields inside nested option buckets.
 */
export function buildClientMiddlewares(input: BuildClientMiddlewaresInput): ClientMiddleware[] {
  const env = input.env ?? process.env;
  const cliOpts = input.cliOpts ?? {};
  const built: ClientMiddleware[] = [];
  for (const name of input.enabled) {
    const factory = factories.get(name);
    if (!factory) {
      const known = Array.from(factories.keys()).sort().join(", ") || "(none registered)";
      throw new Error(
        `Unknown client middleware "${name}". Known: ${known}. ` +
          "Did you typo --client-middleware or N8N_CLIENT_MIDDLEWARES?",
      );
    }
    const fromEnv = factory.loadFromEnv(env);
    const fromCli = factory.loadFromCLI(cliOpts);
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
