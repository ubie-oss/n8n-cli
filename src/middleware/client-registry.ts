import { claimsCollide, type HeaderClaim } from "./header-claims.ts";
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
  /**
   * Per-middleware option sections from `.n8nctlrc.json`
   * (`middlewares.options`), keyed by middleware name. Lowest precedence:
   * file < env < CLI flags.
   */
  fileOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Resolves and builds the enabled client middlewares.
 *
 * Same precedence model as `buildMiddlewares`: config file < env < CLI
 * flags, with deep merge per top-level key so partial CLI overrides don't
 * wipe file/env-supplied fields inside nested option buckets.
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
    const fileSection = input.fileOptions?.[name];
    const fromFile = fileSection ? factory.loadFromCLI(fileSection) : {};
    const fromEnv = factory.loadFromEnv(env);
    const fromCli = factory.loadFromCLI(cliOpts);
    const merged = mergeOptions(
      mergeOptions(fromFile as Record<string, unknown>, fromEnv as Record<string, unknown>),
      fromCli as Record<string, unknown>,
    );
    built.push(factory.build(merged));
  }
  assertNoHeaderConflict(built);
  return built;
}

/**
 * Refuses a chain in which two middlewares claim one header on paths that can
 * overlap.
 *
 * Both would write it and the later one would win, so the chain's declaration
 * order — a deployment detail nothing else depends on — would silently decide
 * which credential reaches the upstream. The failure that produces is a 401
 * from a service that never sees the header it wanted; failing at startup with
 * both names in hand costs an operator minutes instead of hours.
 *
 * Claims whose prefixes cannot both match one request are left alone: two
 * middlewares writing `Authorization` on `/webhook/a/` and `/mcp-server/` never
 * meet, and rejecting that would block a legitimate deployment.
 */
function assertNoHeaderConflict(chain: ClientMiddleware[]): void {
  const seen: { claim: HeaderClaim; owner: string }[] = [];
  for (const mw of chain) {
    for (const claim of mw.headerClaims ?? []) {
      const clash = seen.find((s) => s.owner !== mw.name && claimsCollide(s.claim, claim));
      if (clash) {
        const where = claim.pathPrefix ? ` on paths under "${claim.pathPrefix}"` : "";
        throw new Error(
          `Client middlewares "${clash.owner}" and "${mw.name}" both write the ` +
            `"${claim.header.toLowerCase()}" header${where}, so which one reaches ` +
            "the upstream would depend on chain order. Configure them onto " +
            "different headers (e.g. N8N_IAP_AUTH_HEADER_NAME=proxy-authorization), " +
            "scope them to non-overlapping paths, or drop one.",
        );
      }
      seen.push({ claim, owner: mw.name });
    }
  }
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
