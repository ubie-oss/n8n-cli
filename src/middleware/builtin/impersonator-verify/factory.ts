import { z } from "zod";
import { GoogleTokeninfoVerifier } from "@/middleware/auth/google-tokeninfo.ts";
import { CompositeVerifier, JwksVerifier } from "@/middleware/auth/jwks.ts";
import type { IdTokenVerifier } from "@/middleware/auth/types.ts";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { ImpersonatorVerifyMiddleware } from "./middleware.ts";
import type {
  ImpersonatorRequirement,
  ImpersonatorVerifierKind,
  ImpersonatorVerifyEnforce,
  ImpersonatorVerifyOptions,
} from "./types.ts";

const enforceSchema: z.ZodType<ImpersonatorVerifyEnforce> = z.union([
  z.literal("off"),
  z.literal("warn"),
  z.literal("deny"),
]);

const requirementSchema: z.ZodType<ImpersonatorRequirement> = z.union([
  z.literal("require"),
  z.literal("optional"),
]);

const verifierKindSchema: z.ZodType<ImpersonatorVerifierKind> = z.union([
  z.literal("google-tokeninfo"),
  z.literal("jwks"),
]);

const jwksIssuerSchema = z.object({
  issuer: z.string().min(1),
  jwksUri: z.string().min(1),
});

const optionsSchema = z.object({
  enforce: enforceSchema.default("deny"),
  requirement: requirementSchema.default("optional"),
  expectedAudiences: z.array(z.string().min(1)).default([]),
  verifiers: z.array(verifierKindSchema).min(1).default(["google-tokeninfo"]),
  jwksIssuers: z.array(jwksIssuerSchema).default([]),
  identityClaim: z.string().min(1).default("email"),
  emailVerifiedClaim: z.string().default("email_verified"),
});

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse `iss=https://.../jwks,iss2=https://.../jwks`. Split on the first
 * `=` only, since an issuer is frequently a URL and a JWKS URL can carry
 * a query string.
 */
function parseJwksIssuers(raw: string | undefined) {
  const entries = splitList(raw);
  if (!entries) return undefined;
  return entries.map((entry) => {
    const at = entry.indexOf("=");
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(`Invalid JWKS issuer mapping "${entry}"; expected "<issuer>=<jwks-url>".`);
    }
    return {
      issuer: entry.slice(0, at).trim(),
      jwksUri: entry.slice(at + 1).trim(),
    };
  });
}

/**
 * Assemble the verifier chain from configuration. Kept separate from the
 * middleware so the middleware stays unaware of which issuers exist.
 */
function buildVerifier(options: {
  verifiers: ImpersonatorVerifierKind[];
  jwksIssuers: Array<{ issuer: string; jwksUri: string }>;
  identityClaim: string;
  emailVerifiedClaim: string;
}): IdTokenVerifier {
  const chain = options.verifiers.map((kind): IdTokenVerifier => {
    if (kind === "google-tokeninfo") return new GoogleTokeninfoVerifier();
    if (options.jwksIssuers.length === 0) {
      // Fail loudly at startup rather than build a verifier that silently
      // rejects every token it is handed.
      throw new Error(
        "impersonator-verify: the jwks verifier is enabled but no issuers are configured " +
          "(set N8N_IMPERSONATOR_VERIFY_JWKS_ISSUERS).",
      );
    }
    return new JwksVerifier({
      issuers: options.jwksIssuers,
      identityClaim: options.identityClaim,
      emailVerifiedClaim: options.emailVerifiedClaim,
    });
  });
  return chain.length === 1 ? (chain[0] as IdTokenVerifier) : new CompositeVerifier(chain);
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<ImpersonatorVerifyOptions> {
  const out: Partial<ImpersonatorVerifyOptions> = {};
  if (env.N8N_IMPERSONATOR_VERIFY_ENFORCE) {
    out.enforce = env.N8N_IMPERSONATOR_VERIFY_ENFORCE as ImpersonatorVerifyEnforce;
  }
  if (env.N8N_IMPERSONATOR_VERIFY_REQUIREMENT) {
    out.requirement = env.N8N_IMPERSONATOR_VERIFY_REQUIREMENT as ImpersonatorRequirement;
  }
  const aud = splitList(env.N8N_IMPERSONATOR_VERIFY_EXPECTED_AUDIENCES);
  if (aud) out.expectedAudiences = aud;
  const verifiers = splitList(env.N8N_IMPERSONATOR_VERIFY_VERIFIERS);
  if (verifiers) out.verifiers = verifiers as ImpersonatorVerifierKind[];
  const issuers = parseJwksIssuers(env.N8N_IMPERSONATOR_VERIFY_JWKS_ISSUERS);
  if (issuers) out.jwksIssuers = issuers;
  if (env.N8N_IMPERSONATOR_VERIFY_IDENTITY_CLAIM) {
    out.identityClaim = env.N8N_IMPERSONATOR_VERIFY_IDENTITY_CLAIM;
  }
  // Compared against undefined, not truthiness: an empty value is the
  // documented way to turn the check off.
  if (env.N8N_IMPERSONATOR_VERIFY_EMAIL_VERIFIED_CLAIM !== undefined) {
    out.emailVerifiedClaim = env.N8N_IMPERSONATOR_VERIFY_EMAIL_VERIFIED_CLAIM;
  }
  return out;
}

function fromCLI(opts: Record<string, unknown>): Partial<ImpersonatorVerifyOptions> {
  const out: Partial<ImpersonatorVerifyOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const list = (k: string) => splitList(s(k));

  if (s("impersonatorVerifyEnforce")) {
    out.enforce = s("impersonatorVerifyEnforce") as ImpersonatorVerifyEnforce;
  }
  if (s("impersonatorVerifyRequirement")) {
    out.requirement = s("impersonatorVerifyRequirement") as ImpersonatorRequirement;
  }
  const aud = list("impersonatorVerifyExpectedAudiences");
  if (aud) out.expectedAudiences = aud;
  const verifiers = list("impersonatorVerifyVerifiers");
  if (verifiers) out.verifiers = verifiers as ImpersonatorVerifierKind[];
  const issuers = parseJwksIssuers(s("impersonatorVerifyJwksIssuers"));
  if (issuers) out.jwksIssuers = issuers;
  if (s("impersonatorVerifyIdentityClaim")) {
    out.identityClaim = s("impersonatorVerifyIdentityClaim");
  }
  if (typeof opts.impersonatorVerifyEmailVerifiedClaim === "string") {
    out.emailVerifiedClaim = opts.impersonatorVerifyEmailVerifiedClaim;
  }
  return out;
}

export const impersonatorVerifyFactory: ServerMiddlewareFactory<ImpersonatorVerifyOptions> = {
  name: "impersonator-verify",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    const injected = (merged as { verifier?: IdTokenVerifier } | null)?.verifier;
    return new ImpersonatorVerifyMiddleware({
      ...(parsed as ImpersonatorVerifyOptions),
      verifier: injected ?? buildVerifier(parsed),
    });
  },
};

export const impersonatorVerifyOptionsSchema = optionsSchema;
