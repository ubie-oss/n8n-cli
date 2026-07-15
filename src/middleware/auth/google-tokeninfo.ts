import type { IdTokenVerifier, VerifiedClaim } from "./types.ts";

/**
 * `IdTokenVerifier` implementation that delegates to Google's public
 * `tokeninfo` endpoint. Suitable when callers present Google-signed
 * id_tokens (Cloud Run IAM, IAP JWTs, Workspace OAuth, and any other
 * flow that ends in a Google-issued token).
 *
 * Non-Google deployments should provide their own `IdTokenVerifier`
 * implementation and inject it into the middleware constructors
 * directly. This class is exported so it can serve as a reference
 * implementation and as the factory default when Google is the issuer.
 *
 * Design notes:
 *
 * - The endpoint returns already-parsed claims including `email_verified`
 *   (a normalized boolean-as-string). Local JWKS verification would leave
 *   the caller to re-derive that from the payload — one more chance to
 *   drift from the issuer's semantics.
 * - Latency is a per-request round-trip, but the tokens themselves are
 *   long-lived (~1h) so results are highly cacheable. We cache below
 *   with a small in-memory map keyed by token string.
 * - Only *positive* responses are cached; a negative outcome is either a
 *   real verification failure (in which case a new call is cheap because
 *   the token is bad anyway) or a transient network hiccup that
 *   shouldn't be memoized.
 * - The cache entry's expiry is capped by the token's own `exp` claim,
 *   so a cached positive verdict cannot outlive the token itself.
 *
 * Failure model: `verify()` returns `null` for any reason (bad signature,
 * network error, bad issuer, wrong audience, missing email). Callers do
 * NOT differentiate between these — the correct action is always
 * "reject the token".
 */

/** Raw shape of Google's `tokeninfo` response — see https://oauth2.googleapis.com/tokeninfo docs. */
interface TokeninfoResponse {
  email?: string;
  email_verified?: string; // string "true" / "false"
  aud?: string;
  iss?: string;
  exp?: string; // seconds since epoch, as string
  sub?: string;
}

/** Accepted issuer values in Google id_tokens. */
export const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

/** Narrow fetch signature so tests can stub without touching global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleTokeninfoVerifierOptions {
  /** Endpoint override — production leaves this unset. */
  baseUrl?: string;
  /** HTTP timeout per verification. Default 5 s. */
  timeoutMs?: number;
  /** Cache TTL cap for positive responses. Default 5 min. */
  cacheTtlMs?: number;
  fetcher?: FetchLike;
  now?: () => number;
}

interface CacheEntry {
  claim: VerifiedClaim;
  expiresAt: number;
}

const DEFAULT_BASE_URL = "https://oauth2.googleapis.com/tokeninfo";

export class GoogleTokeninfoVerifier implements IdTokenVerifier {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: GoogleTokeninfoVerifierOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
  }

  async verify(idToken: string): Promise<VerifiedClaim | null> {
    if (!idToken) return null;
    const cached = this.cache.get(idToken);
    if (cached && cached.expiresAt > this.now()) {
      return cached.claim;
    }
    const claim = await this.fetch(idToken);
    if (claim) {
      // Cap the cache entry at the token's own `exp` so a cached positive
      // verdict never outlives the token. Falls back to configured TTL
      // when `exp` is missing.
      const configuredExpiry = this.now() + this.cacheTtlMs;
      const tokenExpiryMs =
        typeof claim.exp === "number" ? claim.exp * 1000 : Number.POSITIVE_INFINITY;
      this.cache.set(idToken, {
        claim,
        expiresAt: Math.min(configuredExpiry, tokenExpiryMs),
      });
    }
    return claim;
  }

  private async fetch(idToken: string): Promise<VerifiedClaim | null> {
    const url = `${this.baseUrl}?id_token=${encodeURIComponent(idToken)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(url, { method: "GET", signal: controller.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as TokeninfoResponse;
      if (!json || typeof json !== "object") return null;
      if (typeof json.iss !== "string" || !GOOGLE_ISSUERS.has(json.iss)) return null;
      if (typeof json.aud !== "string" || json.aud.length === 0) return null;
      const expNum =
        typeof json.exp === "string" && /^\d+$/.test(json.exp) ? Number(json.exp) : undefined;
      return {
        email: json.email,
        emailVerified: json.email_verified === "true",
        aud: json.aud,
        sub: typeof json.sub === "string" ? json.sub : undefined,
        iss: json.iss,
        exp: expNum,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
