import type { IdTokenVerifier, VerifiedClaim } from "./types.ts";

/**
 * `IdTokenVerifier` that validates a JWT against the signing keys its
 * issuer publishes as a JWK Set — the standard OIDC verification shape.
 *
 * Where `GoogleTokeninfoVerifier` asks a Google-hosted endpoint "is this
 * token good?", this verifier answers the question locally: fetch the
 * issuer's public keys once, then check the signature itself. That makes
 * it work for any issuer that publishes a JWKS, which in practice means
 * any OIDC provider, any cloud workload identity, and any platform that
 * can sign a JWT with a key it publishes:
 *
 *   - a service account signing an assertion about a human it
 *     authenticated (keys at the provider's JWKS endpoint for that
 *     account),
 *   - a CI system's OIDC token (`token.actions.githubusercontent.com`
 *     and friends),
 *   - Kubernetes projected ServiceAccount tokens / SPIFFE JWT-SVIDs,
 *   - a corporate IdP (Okta, Auth0, Keycloak, Entra ID).
 *
 * Trust model: an entry in `issuers` is a statement by the operator that
 * "this issuer may assert identities to us". Nothing else grants that.
 * A token whose `iss` is not listed is rejected without any network call,
 * which also makes this verifier cheap to place first in a chain — it
 * declines foreign tokens instantly rather than spending a round trip.
 *
 * What "verified" means here: the listed issuer signed this assertion.
 * Whether the issuer is entitled to speak for the identity inside is the
 * operator's decision, expressed by listing it. Deployments that want the
 * issuer to *also* self-attest verification (the OIDC `email_verified`
 * convention) keep `emailVerifiedClaim` set; deployments whose issuer has
 * no such claim (CI tokens carrying a username, say) clear it and pick
 * the identity claim explicitly.
 *
 * Failure model matches the rest of `IdTokenVerifier`: any problem
 * returns `null`. Callers reject; they never need the reason.
 */

/** Narrow fetch signature so tests can stub without touching global fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One issuer the deployment is willing to accept assertions from. */
export interface JwksIssuer {
  /** Exact `iss` claim value. */
  issuer: string;
  /** URL where that issuer publishes its JWK Set. */
  jwksUri: string;
}

export interface JwksVerifierOptions {
  /**
   * Issuers this verifier accepts. An empty list makes every token fail,
   * which is the correct fail-closed reading of "no issuer configured".
   */
  issuers: JwksIssuer[];
  /**
   * Claim carrying the identity the caller is asserting. Default `email`
   * to match OIDC. Set to e.g. `sub` or `actor` for issuers that do not
   * mint email claims.
   */
  identityClaim?: string;
  /**
   * Boolean claim that must be `true` for the token to pass, mirroring
   * OIDC's `email_verified`. Set to an empty string to skip the check —
   * required for issuers that do not emit it.
   */
  emailVerifiedClaim?: string;
  /** Tolerance applied to `exp` / `nbf` / `iat`, in seconds. Default 60. */
  clockSkewSec?: number;
  /** How long a fetched key set may be reused. Default 10 min. */
  jwksCacheTtlMs?: number;
  /**
   * Floor between JWKS refetches triggered by an unknown `kid`. Bounds
   * how hard a token with a bogus `kid` can hammer the issuer. Default 30 s.
   */
  jwksMinRefetchMs?: number;
  /** HTTP timeout per JWKS fetch. Default 5 s. */
  timeoutMs?: number;
  fetcher?: FetchLike;
  now?: () => number;
}

/** Subset of a JWK we care about, post-validation. */
interface ParsedJwk {
  kid?: string;
  alg?: string;
  kty: string;
  // RSA
  n?: string;
  e?: string;
  // EC
  crv?: string;
  x?: string;
  y?: string;
}

interface KeySetEntry {
  keys: ParsedJwk[];
  fetchedAt: number;
}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

/**
 * Signature algorithms we verify. Restricting the set is deliberate:
 * accepting whatever the token's own header names is how `alg=none` and
 * RSA/HMAC confusion attacks get in. Both entries are asymmetric, so a
 * token can only be produced by the holder of the issuer's private key.
 */
const ALGORITHMS = {
  RS256: { kty: "RSA" },
  ES256: { kty: "EC" },
} as const satisfies Record<string, { kty: string }>;

type SupportedAlg = keyof typeof ALGORITHMS;

function isSupportedAlg(alg: string): alg is SupportedAlg {
  return Object.hasOwn(ALGORITHMS, alg);
}

export class JwksVerifier implements IdTokenVerifier {
  private readonly issuers: Map<string, string>;
  private readonly identityClaim: string;
  private readonly emailVerifiedClaim: string;
  private readonly clockSkewSec: number;
  private readonly jwksCacheTtlMs: number;
  private readonly jwksMinRefetchMs: number;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly keySets = new Map<string, KeySetEntry>();
  /** In-flight fetches, so concurrent verifies share one round trip. */
  private readonly inflight = new Map<string, Promise<KeySetEntry | null>>();

  constructor(opts: JwksVerifierOptions) {
    this.issuers = new Map(opts.issuers.map((i) => [i.issuer, i.jwksUri]));
    this.identityClaim = opts.identityClaim ?? "email";
    this.emailVerifiedClaim = opts.emailVerifiedClaim ?? "email_verified";
    this.clockSkewSec = opts.clockSkewSec ?? 60;
    this.jwksCacheTtlMs = opts.jwksCacheTtlMs ?? 10 * 60 * 1000;
    this.jwksMinRefetchMs = opts.jwksMinRefetchMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
  }

  async verify(idToken: string): Promise<VerifiedClaim | null> {
    const parts = parseJwt(idToken);
    if (!parts) return null;

    // Reject foreign issuers before touching the network. This is what
    // lets a chain put this verifier first without paying for it.
    const iss = parts.payload.iss;
    if (typeof iss !== "string") return null;
    const jwksUri = this.issuers.get(iss);
    if (!jwksUri) return null;

    const alg = parts.header.alg;
    if (typeof alg !== "string" || !isSupportedAlg(alg)) return null;

    const kid = typeof parts.header.kid === "string" ? parts.header.kid : undefined;
    const key = await this.resolveKey(jwksUri, kid, ALGORITHMS[alg].kty);
    if (!key) return null;

    const ok = await verifySignature(key, alg, parts);
    if (!ok) return null;

    return this.buildClaim(parts.payload, iss);
  }

  /** Validate the time window and pull the claims the middlewares read. */
  private buildClaim(payload: Record<string, unknown>, iss: string): VerifiedClaim | null {
    const nowSec = Math.floor(this.now() / 1000);

    // `exp` is mandatory. A signed assertion with no expiry is a
    // permanent credential, which is never what an identity assertion
    // should be.
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    if (nowSec > exp + this.clockSkewSec) return null;

    const nbf = payload.nbf;
    if (typeof nbf === "number" && nowSec + this.clockSkewSec < nbf) return null;

    const iat = payload.iat;
    if (typeof iat === "number" && nowSec + this.clockSkewSec < iat) return null;

    // `VerifiedClaim` carries a single audience because that is what the
    // middlewares pin against. A multi-valued `aud` would force us to
    // pick one arbitrarily, so we decline it rather than guess.
    const aud = normalizeAudience(payload.aud);
    if (!aud) return null;

    if (this.emailVerifiedClaim && payload[this.emailVerifiedClaim] !== true) {
      return null;
    }

    const identity = payload[this.identityClaim];
    if (typeof identity !== "string" || identity.length === 0) return null;

    return {
      email: identity,
      // The allowlisted issuer signed this. See the class doc for what
      // that does and does not mean.
      emailVerified: true,
      aud,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      iss,
      exp,
    };
  }

  /**
   * Find the signing key, refetching once when the `kid` is unknown so a
   * key rotation heals without waiting out the cache TTL.
   */
  private async resolveKey(
    jwksUri: string,
    kid: string | undefined,
    kty: string,
  ): Promise<ParsedJwk | null> {
    const cached = this.keySets.get(jwksUri);
    const fresh = cached && this.now() - cached.fetchedAt < this.jwksCacheTtlMs;
    if (fresh) {
      const hit = selectKey(cached.keys, kid, kty);
      if (hit) return hit;
      // Unknown kid against a still-fresh cache: the issuer may have
      // rotated. Refetch, but not more often than the floor allows.
      if (this.now() - cached.fetchedAt < this.jwksMinRefetchMs) return null;
    }

    const loaded = await this.loadKeySet(jwksUri);
    if (!loaded) return null;
    return selectKey(loaded.keys, kid, kty);
  }

  private async loadKeySet(jwksUri: string): Promise<KeySetEntry | null> {
    const existing = this.inflight.get(jwksUri);
    if (existing) return existing;

    const task = this.fetchKeySet(jwksUri)
      .then((entry) => {
        if (entry) this.keySets.set(jwksUri, entry);
        return entry;
      })
      .finally(() => {
        this.inflight.delete(jwksUri);
      });

    this.inflight.set(jwksUri, task);
    return task;
  }

  private async fetchKeySet(jwksUri: string): Promise<KeySetEntry | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(jwksUri, { method: "GET", signal: controller.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { keys?: unknown };
      if (!json || !Array.isArray(json.keys)) return null;
      const keys = json.keys.map(parseJwk).filter((k): k is ParsedJwk => k !== null);
      if (keys.length === 0) return null;
      return { keys, fetchedAt: this.now() };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Chains verifiers, taking the first that accepts the token. Deployments
 * that serve more than one kind of caller need this: a human's IdP token
 * and a platform's signed assertion arrive in the same header and only
 * their issuer tells them apart.
 *
 * Order matters only for cost, not for correctness — each verifier is
 * responsible for declining tokens that are not its own. Putting cheap,
 * local-rejecting verifiers (like `JwksVerifier`) first avoids paying a
 * network round trip to prove a token was never for that verifier.
 */
export class CompositeVerifier implements IdTokenVerifier {
  constructor(private readonly verifiers: IdTokenVerifier[]) {}

  async verify(idToken: string): Promise<VerifiedClaim | null> {
    for (const verifier of this.verifiers) {
      const claim = await verifier.verify(idToken);
      if (claim) return claim;
    }
    return null;
  }
}

function selectKey(keys: ParsedJwk[], kid: string | undefined, kty: string): ParsedJwk | null {
  const candidates = keys.filter((k) => k.kty === kty);
  if (kid) return candidates.find((k) => k.kid === kid) ?? null;
  // No `kid` in the header: only unambiguous when the issuer publishes a
  // single key of that type. Picking one of several would mean trying
  // keys until one matches, which turns a malformed token into work.
  return candidates.length === 1 ? (candidates[0] as ParsedJwk) : null;
}

function parseJwk(raw: unknown): ParsedJwk | null {
  if (!raw || typeof raw !== "object") return null;
  const jwk = raw as Record<string, unknown>;
  const kty = jwk.kty;
  if (typeof kty !== "string") return null;
  const str = (k: string) => (typeof jwk[k] === "string" ? (jwk[k] as string) : undefined);

  if (kty === "RSA") {
    const n = str("n");
    const e = str("e");
    if (!n || !e) return null;
    return { kty, n, e, kid: str("kid"), alg: str("alg") };
  }
  if (kty === "EC") {
    const crv = str("crv");
    const x = str("x");
    const y = str("y");
    if (!crv || !x || !y) return null;
    return { kty, crv, x, y, kid: str("kid"), alg: str("alg") };
  }
  return null;
}

async function verifySignature(
  jwk: ParsedJwk,
  alg: SupportedAlg,
  parts: JwtParts,
): Promise<boolean> {
  try {
    // Hand WebCrypto only the fields the key type needs. Passing the
    // issuer's JWK through verbatim risks `use` / `key_ops` combinations
    // that some runtimes reject outright.
    if (alg === "RS256") {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        parts.signature,
        parts.signingInput,
      );
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      parts.signature,
      parts.signingInput,
    );
  } catch {
    return false;
  }
}

/**
 * Split and decode a compact JWS. Returns null for anything that is not
 * three base64url segments with JSON in the first two.
 */
function parseJwt(token: string): JwtParts | null {
  let raw = token.trim();
  if (raw.toLowerCase().startsWith("bearer ")) raw = raw.slice(7).trim();
  const segments = raw.split(".");
  if (segments.length !== 3) return null;
  const [h, p, s] = segments as [string, string, string];
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(h))) as unknown;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p))) as unknown;
    if (!isPlainObject(header) || !isPlainObject(payload)) return null;
    return {
      header,
      payload,
      signingInput: new TextEncoder().encode(`${h}.${p}`),
      signature: base64UrlToBytes(s),
    };
  } catch {
    return null;
  }
}

function normalizeAudience(aud: unknown): string | null {
  if (typeof aud === "string" && aud.length > 0) return aud;
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string" && aud[0].length > 0) {
    return aud[0];
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(b64, "base64");
  // Copy into a plain ArrayBuffer-backed view: WebCrypto's BufferSource
  // does not accept the SharedArrayBuffer-capable type Buffer carries.
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}
