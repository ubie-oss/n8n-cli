import { z } from "zod";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";
import { AdcUserTokenSource } from "./adc-user-token-source.ts";
import { ImpersonatorTokenMiddleware } from "./middleware.ts";
import {
  EnvUserTokenSource,
  StaticUserTokenSource,
  type UserTokenSource,
} from "./user-token-source.ts";

/** Default header — must match `impersonator-verify`'s DEFAULT_IMPERSONATOR_HEADER. */
const DEFAULT_HEADER_NAME = "X-Impersonator-Id-Token";

const optionsSchema = z.object({
  /**
   * `aud` for the minted id_token. Required — every issuer has a
   * different audience convention (an OAuth client id, a resource URI,
   * an OIDC RP identifier). Set this to whatever value the server-side
   * `impersonator-verify` expects.
   */
  audience: z.string().min(1, {
    message:
      "impersonator-token: `audience` is required. Set it to the aud claim your server expects on impersonator tokens.",
  }),
  tokenSourceKind: z
    .union([z.literal("adc"), z.literal("env"), z.literal("static")])
    .default("env"),
  /** For tokenSourceKind=env. */
  tokenEnvVar: z.string().optional(),
  /** For tokenSourceKind=static — programmatic use only (tests / preminted). */
  staticToken: z.string().optional(),
  onError: z.union([z.literal("throw"), z.literal("skip")]).default("throw"),
});

type ImpersonatorTokenRawOptions = z.infer<typeof optionsSchema>;

function buildTokenSource(opts: ImpersonatorTokenRawOptions): UserTokenSource {
  switch (opts.tokenSourceKind) {
    case "static": {
      if (!opts.staticToken) {
        throw new Error("impersonator-token: tokenSourceKind=static requires staticToken");
      }
      return new StaticUserTokenSource(opts.staticToken);
    }
    case "env": {
      if (!opts.tokenEnvVar) {
        throw new Error("impersonator-token: tokenSourceKind=env requires tokenEnvVar");
      }
      return new EnvUserTokenSource(opts.tokenEnvVar);
    }
    case "adc":
      // gcloud Application Default Credentials — see adc-user-token-source.ts.
      // Kept behind an explicit `adc` selector rather than made the default so
      // that non-gcloud deployments don't get Google's OAuth token endpoint
      // dialled at them silently.
      return new AdcUserTokenSource();
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<ImpersonatorTokenRawOptions> {
  const out: Partial<ImpersonatorTokenRawOptions> = {};
  if (env.N8N_IMPERSONATOR_TOKEN_AUDIENCE) out.audience = env.N8N_IMPERSONATOR_TOKEN_AUDIENCE;
  if (env.N8N_IMPERSONATOR_TOKEN_SOURCE) {
    out.tokenSourceKind =
      env.N8N_IMPERSONATOR_TOKEN_SOURCE as ImpersonatorTokenRawOptions["tokenSourceKind"];
  }
  if (env.N8N_IMPERSONATOR_TOKEN_ENV_VAR) out.tokenEnvVar = env.N8N_IMPERSONATOR_TOKEN_ENV_VAR;
  if (env.N8N_IMPERSONATOR_TOKEN_ON_ERROR) {
    out.onError = env.N8N_IMPERSONATOR_TOKEN_ON_ERROR as "throw" | "skip";
  }
  return out;
}

function fromCLI(opts: Record<string, unknown>): Partial<ImpersonatorTokenRawOptions> {
  const out: Partial<ImpersonatorTokenRawOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  if (s("impersonatorTokenAudience")) out.audience = s("impersonatorTokenAudience");
  if (s("impersonatorTokenSource")) {
    out.tokenSourceKind = s(
      "impersonatorTokenSource",
    ) as ImpersonatorTokenRawOptions["tokenSourceKind"];
  }
  if (s("impersonatorTokenEnvVar")) out.tokenEnvVar = s("impersonatorTokenEnvVar");
  if (s("impersonatorTokenOnError")) {
    out.onError = s("impersonatorTokenOnError") as "throw" | "skip";
  }
  return out;
}

export const impersonatorTokenFactory: ClientMiddlewareFactory<ImpersonatorTokenRawOptions> = {
  name: "impersonator-token",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    const tokenSource = buildTokenSource(parsed);
    return new ImpersonatorTokenMiddleware({
      audience: parsed.audience,
      headerName: DEFAULT_HEADER_NAME,
      tokenSource,
      onError: parsed.onError,
    });
  },
};

export const impersonatorTokenOptionsSchema = optionsSchema;
