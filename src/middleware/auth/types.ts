/**
 * Generic identity-token verification contract.
 *
 * The `oauth-verify` and `impersonator-verify` server middlewares are
 * verifier-agnostic — they take any implementation of `IdTokenVerifier`
 * and delegate the "is this a real signed token?" question to it. This
 * keeps the middlewares themselves free of any assumption about who
 * issued the token, what wire format it takes, or how signature
 * verification happens.
 *
 * Concrete verifiers live under `src/middleware/auth/` next to this file:
 *
 *   - `GoogleTokeninfoVerifier` — hits Google's `tokeninfo` endpoint. The
 *     obvious choice when the deployment authenticates callers with
 *     Google-signed id_tokens (Cloud Run IAM tokens, Google Workspace
 *     OAuth, IAP JWTs, etc.).
 *
 * Custom deployments plug their own verifier in programmatically via the
 * middleware constructor (`options.verifier`) or through a bespoke
 * factory. Nothing in the middleware code path is Google-specific.
 */

/** What a verified token claim exposes to the middlewares. */
export interface VerifiedClaim {
  /** Verified subject email. `oauth-verify` requires this to be present. */
  email?: string;
  /** True iff the verifier considers the email ownership proven. */
  emailVerified: boolean;
  /** Audience claim; the middleware pins this against a configured allowlist. */
  aud: string;
  /** Optional subject id — some verifiers expose it, most middlewares don't need it. */
  sub?: string;
  /** Optional issuer — verifiers that whitelist issuers already enforced this. */
  iss?: string;
  /** Optional expiry in seconds since epoch. Used by caching layers to cap TTL. */
  exp?: number;
}

/**
 * Pluggable verifier contract. An implementation is expected to:
 *   - Cryptographically verify the token signature against its issuer
 *   - Reject the token on any of {bad signature, wrong issuer, expired}
 *   - Return normalised claims when the token verifies
 *   - Return `null` for any failure (callers do not need to differentiate)
 *
 * Implementations MAY cache successful verifications. When they do, the
 * cache MUST honour the token's own `exp` — a cache entry cannot outlive
 * the token itself, otherwise expired tokens replay past their rated
 * lifetime.
 */
export interface IdTokenVerifier {
  verify(idToken: string): Promise<VerifiedClaim | null>;
}

/** Reads a Bearer token from an `Authorization` header value. Returns null when absent or malformed. */
export function parseBearer(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m?.[1] ?? null;
}
