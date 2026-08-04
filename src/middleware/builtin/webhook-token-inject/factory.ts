import { z } from "zod";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";
import { WebhookTokenInjectMiddleware } from "./middleware.ts";

/** RFC 7230 field-name: one or more token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A rule as written in configuration.
 *
 * The token is supplied one of two ways:
 *   - `tokenEnvVar`: name of an env var holding it. Preferred — the rule set
 *     itself travels through env/CLI, and a value written inline there lands
 *     in process listings, deployment manifests and config dumps.
 *   - `token`: the literal value, for setups that already inject config from a
 *     secret store and have nowhere else to put it.
 *
 * Exactly one of the two: accepting both would leave which one wins to
 * chance, and a rule silently reading the wrong secret fails in the least
 * debuggable way possible.
 */
const ruleSchema = z
  .object({
    pathPrefix: z
      .string({ message: "webhook-token-inject: rule.pathPrefix is required" })
      .min(1, { message: "webhook-token-inject: rule.pathPrefix must not be empty" })
      .startsWith("/", {
        message: "webhook-token-inject: rule.pathPrefix must start with '/'",
      }),
    header: z
      .string({ message: "webhook-token-inject: rule.header is required" })
      .regex(HEADER_NAME, {
        message: "webhook-token-inject: rule.header must be a valid HTTP header name",
      }),
    token: z.string().min(1).optional(),
    tokenEnvVar: z.string().min(1).optional(),
    conflictPolicy: z
      .union([z.literal("replace"), z.literal("set-if-absent")])
      .default("set-if-absent"),
  })
  .refine((r) => Boolean(r.token) !== Boolean(r.tokenEnvVar), {
    message:
      "webhook-token-inject: each rule needs exactly one of token / tokenEnvVar " +
      "(tokenEnvVar is preferred — it keeps the secret out of the rule set)",
  });

const optionsSchema = z.object({
  rules: z
    .array(ruleSchema)
    .min(1, {
      message:
        "webhook-token-inject: at least one rule is required " +
        "(set N8N_WEBHOOK_TOKEN_INJECT_RULES). An enabled middleware with no " +
        "rules would silently inject nothing.",
    })
    .max(64, { message: "webhook-token-inject: at most 64 rules" }),
});

type WebhookTokenInjectRawOptions = z.infer<typeof optionsSchema>;

function parseRules(raw: string, source: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`webhook-token-inject: ${source} is not valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `webhook-token-inject: ${source} must be a JSON array of rules, got ${typeof parsed}`,
    );
  }
  return parsed;
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<WebhookTokenInjectRawOptions> {
  const raw = env.N8N_WEBHOOK_TOKEN_INJECT_RULES;
  if (!raw) return {};
  return {
    rules: parseRules(
      raw,
      "N8N_WEBHOOK_TOKEN_INJECT_RULES",
    ) as WebhookTokenInjectRawOptions["rules"],
  };
}

function fromCLI(opts: Record<string, unknown>): Partial<WebhookTokenInjectRawOptions> {
  const raw = opts.webhookTokenInjectRules;
  if (typeof raw !== "string" || raw.length === 0) return {};
  return {
    rules: parseRules(raw, "--webhook-token-inject-rules") as WebhookTokenInjectRawOptions["rules"],
  };
}

/**
 * Resolves `tokenEnvVar` indirections against the process environment.
 *
 * An unresolvable reference is an error rather than a skipped rule: a rule
 * that quietly stops injecting turns into upstream 401/403s far from the
 * misconfiguration that caused them.
 */
function resolveTokens(
  rules: WebhookTokenInjectRawOptions["rules"],
  env: NodeJS.ProcessEnv,
): {
  pathPrefix: string;
  header: string;
  token: string;
  conflictPolicy: "replace" | "set-if-absent";
}[] {
  return rules.map((rule) => {
    let token = rule.token;
    if (rule.tokenEnvVar) {
      const value = env[rule.tokenEnvVar];
      if (!value) {
        throw new Error(
          `webhook-token-inject: rule for ${rule.pathPrefix} references ` +
            `tokenEnvVar "${rule.tokenEnvVar}", which is unset or empty`,
        );
      }
      token = value;
    }
    // `token` is present here: the schema refinement guarantees exactly one of
    // the two sources, and the env branch above either assigned or threw.
    return {
      pathPrefix: rule.pathPrefix,
      header: rule.header,
      token: token as string,
      conflictPolicy: rule.conflictPolicy,
    };
  });
}

export const webhookTokenInjectFactory: ClientMiddlewareFactory<WebhookTokenInjectRawOptions> = {
  name: "webhook-token-inject",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    return new WebhookTokenInjectMiddleware({ rules: resolveTokens(parsed.rules, process.env) });
  },
};

/** Exposed for unit tests that build options directly. */
export const webhookTokenInjectOptionsSchema = optionsSchema;
/** Exposed for unit tests covering the env-var indirection. */
export const resolveWebhookTokenRules = resolveTokens;
