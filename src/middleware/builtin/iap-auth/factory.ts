import { z } from "zod";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";
import { AdcImpersonateTokenSource } from "./adc-impersonate-source.ts";
import { IapAuthMiddleware } from "./middleware.ts";
import {
  EnvTokenSource,
  MetadataServerTokenSource,
  StaticTokenSource,
  type TokenSource,
} from "./token-source.ts";

/**
 * Raw config shape parsed from env/CLI. The runtime middleware doesn't see
 * this — the factory turns it into an `IapAuthOptions` with a concrete
 * `tokenSource` selected.
 */
const optionsSchema = z.object({
  audience: z
    .string({ message: "iap-auth: audience is required (OAuth2 client_id of IAP backend)" })
    .min(1, { message: "iap-auth: audience must not be empty" }),
  /**
   * Where to get the id_token from. Defaults to "metadata" (GCE metadata
   * server) — the production path for workloads. "adc-impersonate" mints the
   * token as `impersonateServiceAccount` using local Application Default
   * Credentials, which is what a developer laptop (no metadata server) needs.
   * "env" reads a pre-minted token from an env var. "static" is for tests.
   */
  tokenSourceKind: z
    .union([
      z.literal("metadata"),
      z.literal("adc-impersonate"),
      z.literal("env"),
      z.literal("static"),
    ])
    .default("metadata"),
  /** Env var name when tokenSourceKind=env. */
  tokenEnvVar: z.string().optional(),
  /** Inline token value when tokenSourceKind=static (tests only). */
  staticToken: z.string().optional(),
  /** Cache TTL in ms (metadata source). Default 50 min — id_tokens live ~1h. */
  cacheTtlMs: z
    .number()
    .int()
    .min(0)
    .default(50 * 60 * 1000),
  /** HTTP timeout per metadata call in ms. */
  timeoutMs: z.number().int().min(1).default(5_000),
  /** Override metadata host (testing). */
  metadataBaseUrl: z.string().url().optional(),
  /**
   * Target service-account email to impersonate. When set, id_tokens are
   * minted via `iamcredentials.googleapis.com:generateIdToken` rather than
   * pulled directly from the metadata server. Only meaningful when
   * tokenSourceKind=metadata (the default).
   *
   * The workload SA running this proxy must have
   * `roles/iam.serviceAccountTokenCreator` on the target SA, and the target
   * SA must have `roles/iap.httpsResourceAccessor` on the upstream IAP
   * backend.
   */
  impersonateServiceAccount: z.string().min(1).optional(),
  /** Override iamcredentials host (testing). */
  iamCredentialsBaseUrl: z.string().url().optional(),
});

type IapAuthRawOptions = z.infer<typeof optionsSchema>;

function buildTokenSource(opts: IapAuthRawOptions): TokenSource {
  switch (opts.tokenSourceKind) {
    case "static": {
      if (!opts.staticToken) {
        throw new Error("iap-auth: tokenSourceKind=static requires staticToken");
      }
      return new StaticTokenSource(opts.staticToken);
    }
    case "env": {
      if (!opts.tokenEnvVar) {
        throw new Error("iap-auth: tokenSourceKind=env requires tokenEnvVar");
      }
      return new EnvTokenSource(opts.tokenEnvVar);
    }
    case "adc-impersonate": {
      if (!opts.impersonateServiceAccount) {
        throw new Error(
          "iap-auth: tokenSourceKind=adc-impersonate requires impersonateServiceAccount " +
            "(the service account whose identity the gateway expects)",
        );
      }
      return new AdcImpersonateTokenSource(opts.impersonateServiceAccount, {
        cacheTtlMs: opts.cacheTtlMs,
        // ADC + IAM Credentials are remote calls, unlike the local metadata
        // server, so the metadata-tuned default timeout is too tight here.
        timeoutMs: Math.max(opts.timeoutMs, 10_000),
        iamCredentialsBaseUrl: opts.iamCredentialsBaseUrl,
      });
    }
    case "metadata":
      return new MetadataServerTokenSource({
        cacheTtlMs: opts.cacheTtlMs,
        timeoutMs: opts.timeoutMs,
        baseUrl: opts.metadataBaseUrl,
        impersonateServiceAccount: opts.impersonateServiceAccount,
        iamCredentialsBaseUrl: opts.iamCredentialsBaseUrl,
      });
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<IapAuthRawOptions> {
  const out: Partial<IapAuthRawOptions> = {};
  // Falling back to the API URL keeps the common case to one variable: when the
  // gateway is a Cloud Run service, the `aud` it expects *is* its URL, and two
  // variables holding the same value only drift apart. The fallback lives here
  // rather than in the CLI wiring so nothing outside this middleware needs to
  // know that `iap-auth` has an audience at all.
  if (env.N8N_IAP_AUTH_AUDIENCE || env.N8N_API_URL) {
    out.audience = env.N8N_IAP_AUTH_AUDIENCE ?? env.N8N_API_URL;
  }
  if (env.N8N_IAP_AUTH_TOKEN_SOURCE) {
    out.tokenSourceKind = env.N8N_IAP_AUTH_TOKEN_SOURCE as IapAuthRawOptions["tokenSourceKind"];
  }
  if (env.N8N_IAP_AUTH_TOKEN_ENV_VAR) out.tokenEnvVar = env.N8N_IAP_AUTH_TOKEN_ENV_VAR;
  if (env.N8N_IAP_AUTH_CACHE_TTL_MS) {
    out.cacheTtlMs = Number.parseInt(env.N8N_IAP_AUTH_CACHE_TTL_MS, 10);
  }
  if (env.N8N_IAP_AUTH_TIMEOUT_MS) {
    out.timeoutMs = Number.parseInt(env.N8N_IAP_AUTH_TIMEOUT_MS, 10);
  }
  if (env.N8N_IAP_AUTH_METADATA_BASE_URL) out.metadataBaseUrl = env.N8N_IAP_AUTH_METADATA_BASE_URL;
  if (env.N8N_IAP_AUTH_IMPERSONATE_SERVICE_ACCOUNT) {
    out.impersonateServiceAccount = env.N8N_IAP_AUTH_IMPERSONATE_SERVICE_ACCOUNT;
  }
  if (env.N8N_IAP_AUTH_IAM_CREDENTIALS_BASE_URL) {
    out.iamCredentialsBaseUrl = env.N8N_IAP_AUTH_IAM_CREDENTIALS_BASE_URL;
  }
  return out;
}

function fromCLI(opts: Record<string, unknown>): Partial<IapAuthRawOptions> {
  const out: Partial<IapAuthRawOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const n = (k: string) => {
    const v = opts[k];
    if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
    if (typeof v === "number") return v;
    return undefined;
  };
  if (s("iapAuthAudience")) out.audience = s("iapAuthAudience");
  if (s("iapAuthTokenSource")) {
    out.tokenSourceKind = s("iapAuthTokenSource") as IapAuthRawOptions["tokenSourceKind"];
  }
  if (s("iapAuthTokenEnvVar")) out.tokenEnvVar = s("iapAuthTokenEnvVar");
  const ttl = n("iapAuthCacheTtlMs");
  if (ttl !== undefined) out.cacheTtlMs = ttl;
  const t = n("iapAuthTimeoutMs");
  if (t !== undefined) out.timeoutMs = t;
  if (s("iapAuthMetadataBaseUrl")) out.metadataBaseUrl = s("iapAuthMetadataBaseUrl");
  if (s("iapAuthImpersonateServiceAccount")) {
    out.impersonateServiceAccount = s("iapAuthImpersonateServiceAccount");
  }
  if (s("iapAuthIamCredentialsBaseUrl")) {
    out.iamCredentialsBaseUrl = s("iapAuthIamCredentialsBaseUrl");
  }
  return out;
}

export const iapAuthFactory: ClientMiddlewareFactory<IapAuthRawOptions> = {
  name: "iap-auth",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    const tokenSource = buildTokenSource(parsed);
    return new IapAuthMiddleware({ audience: parsed.audience, tokenSource });
  },
};

/** Exposed for unit tests that build options directly. */
export const iapAuthOptionsSchema = optionsSchema;
