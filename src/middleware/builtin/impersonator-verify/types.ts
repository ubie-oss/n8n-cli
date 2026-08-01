import type { JwksIssuer } from "@/middleware/auth/jwks.ts";
import type { IdTokenVerifier } from "@/middleware/auth/types.ts";

/** Same enforce semantics as oauth-verify. */
export type ImpersonatorVerifyEnforce = "off" | "warn" | "deny";

/**
 * Verifier implementations the factory can assemble from configuration.
 *
 * - `google-tokeninfo` — Google-issued id_tokens, checked against
 *   Google's tokeninfo endpoint. The historical default.
 * - `jwks` — any issuer publishing a JWK Set. Needed when the identity is
 *   asserted by something other than the user's own IdP login: a platform
 *   signing on behalf of a user it authenticated, a CI system's OIDC
 *   token, a workload identity.
 *
 * Listing both accepts either, which is the normal state for a gateway
 * serving humans and machines through one header.
 */
export type ImpersonatorVerifierKind = "google-tokeninfo" | "jwks";

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
  /**
   * Verifiers to try, in order, when `verifier` is not injected. Order is
   * a cost decision, not a security one — every verifier declines tokens
   * that are not its own. Default `["google-tokeninfo"]`.
   */
  verifiers?: ImpersonatorVerifierKind[];
  /**
   * Issuers the `jwks` verifier accepts, as `iss` → JWKS URL. Required
   * when `jwks` is selected: an issuer is only trusted because it is
   * listed here.
   */
  jwksIssuers?: JwksIssuer[];
  /**
   * Claim the `jwks` verifier reads the caller's identity from. Default
   * `email`. Point it at another claim for issuers that mint usernames or
   * opaque subjects instead.
   */
  identityClaim?: string;
  /**
   * Boolean claim the `jwks` verifier requires to be `true`, following
   * OIDC's `email_verified`. Empty string disables the check, which is
   * necessary for issuers that do not emit it.
   */
  emailVerifiedClaim?: string;
}
