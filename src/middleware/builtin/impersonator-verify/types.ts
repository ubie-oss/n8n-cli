import type { IdTokenVerifier } from "@/middleware/auth/types.ts";

/** Same enforce semantics as oauth-verify. */
export type ImpersonatorVerifyEnforce = "off" | "warn" | "deny";

/**
 * Policy when the request lacks an impersonator token entirely (as opposed
 * to carrying a malformed / mis-audienced one).
 *
 * - `require`  — reject; the endpoint only accepts requests that carry a
 *                verified user-identity side channel.
 * - `optional` — accept, leave `ctx.auth.effective` pointing at the bearer.
 *                Use this for endpoints that also serve machine callers.
 */
export type ImpersonatorRequirement = "require" | "optional";

/** Default header name that both the client middleware and this verifier use. */
export const DEFAULT_IMPERSONATOR_HEADER = "X-Impersonator-Id-Token";

export interface ImpersonatorVerifyOptions {
  enforce: ImpersonatorVerifyEnforce;
  requirement: ImpersonatorRequirement;
  /**
   * Header name carrying the impersonator id_token. Defaults to
   * `X-Impersonator-Id-Token`; leave as default unless the client is
   * emitting a non-standard header name.
   */
  headerName?: string;
  /**
   * Accepted `aud` claim values for the impersonator token. Populate with
   * every audience your clients emit — for gcloud users this is the
   * ADC OAuth client id; for other flows, whatever the issuing OAuth
   * client's identifier is.
   */
  expectedAudiences: string[];
  /**
   * Token verifier. Injected for tests and non-Google deployments. When
   * unset, the factory defaults to `GoogleTokeninfoVerifier`.
   */
  verifier?: IdTokenVerifier;
}
