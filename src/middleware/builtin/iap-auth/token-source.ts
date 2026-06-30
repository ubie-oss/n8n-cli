/**
 * Pluggable source of GCP ID tokens for IAP authentication.
 *
 * The default implementation (`MetadataServerTokenSource`) hits the GCE
 * metadata server, which is the only mechanism that works for a service
 * account attached to a Cloud Run / GCE / GKE workload — no service-account
 * key material on disk required.
 *
 * Tests inject `StaticTokenSource` or a custom implementation; production
 * runs without configuration use the metadata server.
 */
export interface TokenSource {
  /** Returns a (possibly cached) id_token with `aud=audience`. */
  getToken(audience: string): Promise<string>;
}

/** Minimal fetch contract — kept narrow so tests can stub it cleanly. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";

interface CacheEntry {
  token: string;
  /** Epoch millis at which the cached entry stops being usable. */
  expiresAt: number;
}

interface MetadataSourceDeps {
  fetcher?: FetchLike;
  now?: () => number;
  /**
   * Cache lifetime in ms. GCP id_tokens are valid for ~1h; defaulting to
   * 50 min keeps headroom for clock skew and in-flight requests.
   */
  cacheTtlMs?: number;
  /**
   * HTTP timeout per metadata-server call. Metadata calls are local IMDS
   * and should be sub-100ms; we set 5s as a generous fail-safe.
   */
  timeoutMs?: number;
  /** Override for the metadata host (testing). */
  baseUrl?: string;
  /**
   * Target service-account email to impersonate. When set, the source mints
   * id_tokens for THIS SA via `iamcredentials.googleapis.com:generateIdToken`,
   * using the workload's own ADC access_token (also fetched from the metadata
   * server) as the caller credential. When unset, id_tokens come directly
   * from the metadata server for the workload's own SA.
   *
   * Required permission on the workload SA: `roles/iam.serviceAccountTokenCreator`
   * on `impersonateServiceAccount`. The target SA itself needs
   * `roles/iap.httpsResourceAccessor` on the IAP backend.
   */
  impersonateServiceAccount?: string;
  /** Override for the iamcredentials API host (testing). */
  iamCredentialsBaseUrl?: string;
  /**
   * Cache lifetime for the caller's access_token in ms. GCP access_tokens
   * live ~1h; we cache for 50 min to leave headroom. Independent of the
   * id_token cache because the two have different scopes/lifetimes.
   */
  accessTokenCacheTtlMs?: number;
}

/**
 * Fetches id_tokens from the GCE metadata server. Caches per-audience.
 *
 * One instance serves one workload; cache is keyed by audience so a process
 * that authenticates against multiple IAP-protected backends still hits the
 * metadata server only once per audience per TTL window.
 */
export class MetadataServerTokenSource implements TokenSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  /**
   * Single-entry cache for the caller's access_token. Only populated when
   * impersonation is enabled — direct id_token fetches don't need it.
   */
  private accessTokenCache: CacheEntry | null = null;
  private accessTokenInflight: Promise<string> | null = null;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly accessTokenCacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly iamCredentialsBaseUrl: string;
  private readonly impersonateServiceAccount?: string;

  constructor(deps: MetadataSourceDeps = {}) {
    this.fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
    this.cacheTtlMs = deps.cacheTtlMs ?? 50 * 60 * 1000;
    this.accessTokenCacheTtlMs = deps.accessTokenCacheTtlMs ?? 50 * 60 * 1000;
    this.timeoutMs = deps.timeoutMs ?? 5_000;
    this.baseUrl = deps.baseUrl ?? METADATA_BASE;
    this.iamCredentialsBaseUrl = deps.iamCredentialsBaseUrl ?? IAM_CREDENTIALS_BASE;
    this.impersonateServiceAccount = deps.impersonateServiceAccount;
  }

  async getToken(audience: string): Promise<string> {
    const cached = this.cache.get(audience);
    if (cached && cached.expiresAt > this.now()) {
      return cached.token;
    }
    // Coalesce concurrent misses for the same audience into a single fetch.
    const pending = this.inflight.get(audience);
    if (pending) return pending;

    const p = this.fetchAndCache(audience).finally(() => {
      this.inflight.delete(audience);
    });
    this.inflight.set(audience, p);
    return p;
  }

  private async fetchAndCache(audience: string): Promise<string> {
    const token = this.impersonateServiceAccount
      ? await this.mintViaImpersonation(audience, this.impersonateServiceAccount)
      : await this.fetchMetadataIdToken(audience);
    this.cache.set(audience, { token, expiresAt: this.now() + this.cacheTtlMs });
    return token;
  }

  private async fetchMetadataIdToken(audience: string): Promise<string> {
    const url = `${this.baseUrl}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const res = await this.callWithTimeout(url, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`metadata server returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const token = (await res.text()).trim();
    if (!token) {
      throw new Error("metadata server returned empty id_token");
    }
    return token;
  }

  /**
   * Caller-credential path: fetch the workload SA's access_token from the
   * metadata server. Cached because every impersonation call needs it and
   * the value is valid for ~1h.
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessTokenCache && this.accessTokenCache.expiresAt > this.now()) {
      return this.accessTokenCache.token;
    }
    if (this.accessTokenInflight) return this.accessTokenInflight;
    this.accessTokenInflight = this.fetchAccessToken().finally(() => {
      this.accessTokenInflight = null;
    });
    return this.accessTokenInflight;
  }

  private async fetchAccessToken(): Promise<string> {
    const url = `${this.baseUrl}/instance/service-accounts/default/token`;
    const res = await this.callWithTimeout(url, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `metadata server (access_token) returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const parsed = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) {
      throw new Error("metadata server returned no access_token");
    }
    // Honor the server's `expires_in` when present (minus ~10 min slack);
    // fall back to the configured TTL otherwise.
    const ttl =
      typeof parsed.expires_in === "number" && parsed.expires_in > 60
        ? (parsed.expires_in - 60) * 1000
        : this.accessTokenCacheTtlMs;
    this.accessTokenCache = { token: parsed.access_token, expiresAt: this.now() + ttl };
    return parsed.access_token;
  }

  /**
   * Impersonation path: use the caller's access_token to ask the IAM
   * Credentials API to mint an id_token *as* the target service account,
   * with the requested `aud` claim.
   *
   * The caller needs `roles/iam.serviceAccountTokenCreator` on the target SA
   * — a 403 here usually points at that missing role.
   */
  private async mintViaImpersonation(audience: string, targetSa: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    const url = `${this.iamCredentialsBaseUrl}/projects/-/serviceAccounts/${encodeURIComponent(targetSa)}:generateIdToken`;
    const res = await this.callWithTimeout(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audience, includeEmail: false }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `iamcredentials.generateIdToken for ${targetSa} returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const parsed = (await res.json()) as { token?: string };
    if (!parsed.token) {
      throw new Error(`iamcredentials.generateIdToken for ${targetSa} returned no token`);
    }
    return parsed.token;
  }

  private async callWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("metadata/iamcredentials timeout")),
      this.timeoutMs,
    );
    try {
      return await this.fetcher(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Static token returner — for tests and local-dev pre-minted tokens. */
export class StaticTokenSource implements TokenSource {
  constructor(private readonly token: string) {}
  getToken(_audience: string): Promise<string> {
    return Promise.resolve(this.token);
  }
}

/**
 * Reads a pre-minted id_token from an env var. Useful for local development
 * against an IAP-protected endpoint when the metadata server isn't
 * available — the operator obtains a token via gcloud and exports it.
 *
 * Re-reads on every call so rotating the env between requests works (rare
 * but cheap).
 */
export class EnvTokenSource implements TokenSource {
  constructor(
    private readonly varName: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  getToken(_audience: string): Promise<string> {
    const value = this.env[this.varName];
    if (!value) {
      return Promise.reject(new Error(`iap-auth: env var ${this.varName} is not set or empty`));
    }
    return Promise.resolve(value);
  }
}
