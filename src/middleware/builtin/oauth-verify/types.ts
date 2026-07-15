import type { IdTokenVerifier } from "@/middleware/auth/types.ts";

/**
 * Behavior when the incoming Authorization: Bearer is absent, malformed, or
 * fails verification.
 *
 * - `deny`  — return 401 and short-circuit the pipeline. Fail-closed.
 * - `warn`  — record the failure but let the request proceed. Useful during
 *             rollout when tokens are being introduced but not yet enforced.
 * - `off`   — no verification at all. Included for symmetry with authz's
 *             `enforce`; use `--server-middleware` to just not enable this
 *             middleware if you want the same effect.
 */
export type OAuthVerifyEnforce = "off" | "warn" | "deny";

export interface OAuthVerifyOptions {
  enforce: OAuthVerifyEnforce;
  /**
   * Accepted `aud` claim values. Every deployment pins this to the token
   * audiences that map to its own resource — e.g. a Cloud Run service URL,
   * an IAP OAuth client id, a Kubernetes ServiceAccount JWT audience, etc.
   * Empty list = middleware fails-closed because no token can pass.
   */
  expectedAudiences: string[];
  /**
   * Principals whose bearer identity is trusted enough to have an
   * accompanying impersonator token honored. When a bearer's email is in
   * this list, `impersonator-verify` will accept the side-channel
   * identity assertion it carries.
   *
   * "Principal" here means whatever subject the verifier surfaces — an
   * email, an SPIFFE id, an OIDC `sub`, etc. The comparison is a plain
   * string match against the verified `email` claim, so populate this
   * with the exact values your verifier emits.
   */
  trustedPrincipals: string[];
  /**
   * Token verifier. Injected for tests and for deployments that use a
   * non-Google issuer. When left unset, the factory defaults to
   * `GoogleTokeninfoVerifier` — swap that at the factory level (or bypass
   * the factory entirely) to accept another issuer's tokens.
   */
  verifier?: IdTokenVerifier;
}
