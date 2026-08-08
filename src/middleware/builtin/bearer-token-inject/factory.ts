import { z } from "zod";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";
import { BearerTokenInjectMiddleware } from "./middleware.ts";

/** RFC 7235 auth-scheme: a bare token, no separators. */
const AUTH_SCHEME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]*$/;

/**
 * A rule as written in configuration.
 *
 * The token is supplied one of two ways, for the same reason
 * `webhook-token-inject` splits them:
 *   - `tokenEnvVar`: name of an env var holding it. Preferred — the rule set
 *     itself travels through env/CLI, and a value written inline there lands
 *     in process listings, deployment manifests and config dumps.
 *   - `token`: the literal value, for setups that already inject config from a
 *     secret store and have nowhere else to put it.
 *
 * Exactly one of the two: accepting both would leave which one wins to chance,
 * and a rule silently reading the wrong secret fails in the least debuggable
 * way possible.
 */
const ruleSchema = z
  .object({
    pathPrefix: z
      .string({ message: "bearer-token-inject: rule.pathPrefix is required" })
      .min(1, { message: "bearer-token-inject: rule.pathPrefix must not be empty" })
      .startsWith("/", {
        message: "bearer-token-inject: rule.pathPrefix must start with '/'",
      }),
    token: z.string().min(1).optional(),
    tokenEnvVar: z.string().min(1).optional(),
    scheme: z
      .string()
      .regex(AUTH_SCHEME, {
        message: "bearer-token-inject: rule.scheme must be a bare auth-scheme token",
      })
      .default("Bearer"),
  })
  .refine((r) => Boolean(r.token) !== Boolean(r.tokenEnvVar), {
    message:
      "bearer-token-inject: each rule needs exactly one of token / tokenEnvVar " +
      "(tokenEnvVar is preferred — it keeps the secret out of the rule set)",
  });

const optionsSchema = z.object({
  rules: z
    .array(ruleSchema)
    .min(1, {
      message:
        "bearer-token-inject: at least one rule is required " +
        "(set N8N_BEARER_TOKEN_INJECT_RULES). An enabled middleware with no " +
        "rules would silently inject nothing.",
    })
    .max(64, { message: "bearer-token-inject: at most 64 rules" }),
});

type BearerTokenInjectRawOptions = z.infer<typeof optionsSchema>;

function parseRules(raw: string, source: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`bearer-token-inject: ${source} is not valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `bearer-token-inject: ${source} must be a JSON array of rules, got ${typeof parsed}`,
    );
  }
  return parsed;
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<BearerTokenInjectRawOptions> {
  const raw = env.N8N_BEARER_TOKEN_INJECT_RULES;
  if (!raw) return {};
  return {
    rules: parseRules(raw, "N8N_BEARER_TOKEN_INJECT_RULES") as BearerTokenInjectRawOptions["rules"],
  };
}

function fromCLI(opts: Record<string, unknown>): Partial<BearerTokenInjectRawOptions> {
  const raw = opts.bearerTokenInjectRules;
  if (typeof raw !== "string" || raw.length === 0) return {};
  return {
    rules: parseRules(raw, "--bearer-token-inject-rules") as BearerTokenInjectRawOptions["rules"],
  };
}

/**
 * Resolves `tokenEnvVar` indirections against the process environment.
 *
 * An unresolvable reference is an error rather than a skipped rule: a rule that
 * quietly stops injecting turns into upstream 401s far from the
 * misconfiguration that caused them.
 */
function resolveTokens(
  rules: BearerTokenInjectRawOptions["rules"],
  env: NodeJS.ProcessEnv,
): { pathPrefix: string; token: string; scheme: string }[] {
  return rules.map((rule) => {
    let token = rule.token;
    if (rule.tokenEnvVar) {
      const value = env[rule.tokenEnvVar];
      if (!value) {
        throw new Error(
          `bearer-token-inject: rule for ${rule.pathPrefix} references ` +
            `tokenEnvVar "${rule.tokenEnvVar}", which is unset or empty`,
        );
      }
      token = value;
    }
    // `token` is present here: the schema refinement guarantees exactly one of
    // the two sources, and the env branch above either assigned or threw.
    return { pathPrefix: rule.pathPrefix, token: token as string, scheme: rule.scheme };
  });
}

export const bearerTokenInjectFactory: ClientMiddlewareFactory<BearerTokenInjectRawOptions> = {
  name: "bearer-token-inject",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    return new BearerTokenInjectMiddleware({ rules: resolveTokens(parsed.rules, process.env) });
  },
};

/** Exposed for unit tests that build options directly. */
export const bearerTokenInjectOptionsSchema = optionsSchema;
/** Exposed for unit tests covering the env-var indirection. */
export const resolveBearerTokenRules = resolveTokens;
