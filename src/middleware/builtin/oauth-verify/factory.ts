import { z } from "zod";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { OAuthVerifyMiddleware } from "./middleware.ts";
import type { OAuthVerifyEnforce, OAuthVerifyOptions } from "./types.ts";

const enforceSchema: z.ZodType<OAuthVerifyEnforce> = z.union([
  z.literal("off"),
  z.literal("warn"),
  z.literal("deny"),
]);

const optionsSchema = z.object({
  enforce: enforceSchema.default("deny"),
  expectedAudiences: z.array(z.string().min(1)).default([]),
  trustedPrincipals: z.array(z.string().min(1)).default([]),
});

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<OAuthVerifyOptions> {
  const out: Partial<OAuthVerifyOptions> = {};
  if (env.N8N_OAUTH_VERIFY_ENFORCE) {
    out.enforce = env.N8N_OAUTH_VERIFY_ENFORCE as OAuthVerifyEnforce;
  }
  const aud = splitList(env.N8N_OAUTH_VERIFY_EXPECTED_AUDIENCES);
  if (aud) out.expectedAudiences = aud;
  const principals = splitList(env.N8N_OAUTH_VERIFY_TRUSTED_PRINCIPALS);
  if (principals) out.trustedPrincipals = principals;
  return out;
}

function fromCLI(opts: Record<string, unknown>): Partial<OAuthVerifyOptions> {
  const out: Partial<OAuthVerifyOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const list = (k: string) => splitList(s(k));

  if (s("oauthVerifyEnforce")) out.enforce = s("oauthVerifyEnforce") as OAuthVerifyEnforce;
  const aud = list("oauthVerifyExpectedAudiences");
  if (aud) out.expectedAudiences = aud;
  const principals = list("oauthVerifyTrustedPrincipals");
  if (principals) out.trustedPrincipals = principals;
  return out;
}

export const oauthVerifyFactory: ServerMiddlewareFactory<OAuthVerifyOptions> = {
  name: "oauth-verify",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged) as OAuthVerifyOptions;
    return new OAuthVerifyMiddleware(parsed);
  },
};

export const oauthVerifyOptionsSchema = optionsSchema;
