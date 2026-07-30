import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FetchLike, TokenSource } from "./token-source.ts";

/**
 * `TokenSource` that mints an id_token **as a target service account**, using
 * the local Application Default Credentials as the caller.
 *
 * Why this exists: `MetadataServerTokenSource` covers workloads (Cloud Run,
 * GCE, GKE) because it reads the caller's access_token off the metadata
 * server. A developer laptop has no metadata server, so a CLI running there
 * cannot mint the id_token its gateway expects — leaving the operator to run
 * `gcloud auth print-identity-token --impersonate-service-account=...` by hand
 * every hour and paste the result into an env var. This source closes that gap:
 * read ADC from disk, exchange the refresh_token for an access_token, then ask
 * the IAM Credentials API to mint an id_token as the target SA.
 *
 * Requires `roles/iam.serviceAccountTokenCreator` on the target SA for the ADC
 * principal — the same grant `gcloud --impersonate-service-account` needs.
 *
 * Only user credentials (`authorized_user`, i.e. the output of
 * `gcloud auth application-default login`) are supported as the caller.
 * Service-account key files are rejected with an explicit error rather than
 * silently doing something surprising: a workload that has a key file can use
 * the metadata source, and keyless is the direction we want anyway.
 */

const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";
/** GCP id_tokens live ~1h; 50 min leaves headroom for skew and in-flight calls. */
const DEFAULT_CACHE_TTL_MS = 50 * 60 * 1000;

interface AdcUserCredentials {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

export interface AdcImpersonateTokenSourceDeps {
  fetcher?: FetchLike;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** Explicit ADC path (testing / non-default install). */
  credentialsPath?: string;
  /** Injected credentials reader for tests. */
  readCredentials?: () => Promise<AdcUserCredentials>;
  tokenEndpoint?: string;
  iamCredentialsBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function defaultAdcPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit) return explicit;
  if (process.platform === "win32") {
    const appdata = env.APPDATA;
    if (appdata) return join(appdata, "gcloud", "application_default_credentials.json");
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

export class AdcImpersonateTokenSource implements TokenSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly credentialsPath: string;
  private readonly tokenEndpoint: string;
  private readonly iamCredentialsBaseUrl: string;
  private readonly readCredentialsImpl?: () => Promise<AdcUserCredentials>;
  private cachedCreds?: AdcUserCredentials;

  constructor(
    private readonly targetServiceAccount: string,
    deps: AdcImpersonateTokenSourceDeps = {},
  ) {
    const env = deps.env ?? process.env;
    this.fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.credentialsPath = deps.credentialsPath ?? defaultAdcPath(env);
    this.tokenEndpoint = deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.iamCredentialsBaseUrl = deps.iamCredentialsBaseUrl ?? DEFAULT_IAM_CREDENTIALS_BASE;
    this.readCredentialsImpl = deps.readCredentials;
  }

  async getToken(audience: string): Promise<string> {
    const cached = this.cache.get(audience);
    if (cached && cached.expiresAt > this.now()) return cached.token;
    const pending = this.inflight.get(audience);
    if (pending) return pending;
    const p = this.mint(audience).finally(() => this.inflight.delete(audience));
    this.inflight.set(audience, p);
    return p;
  }

  private async readCredentials(): Promise<AdcUserCredentials> {
    if (this.cachedCreds) return this.cachedCreds;
    let raw: AdcUserCredentials;
    try {
      raw = this.readCredentialsImpl
        ? await this.readCredentialsImpl()
        : (JSON.parse(await readFile(this.credentialsPath, "utf8")) as AdcUserCredentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `iap-auth: could not read Application Default Credentials (${this.credentialsPath}): ${message}. ` +
          "Run `gcloud auth application-default login`.",
      );
    }
    if (raw.type && raw.type !== "authorized_user") {
      throw new Error(
        `iap-auth: tokenSourceKind=adc-impersonate expects user credentials (type "authorized_user"), got "${raw.type}". ` +
          "Use tokenSourceKind=metadata for workload identities.",
      );
    }
    if (!raw.refresh_token || !raw.client_id || !raw.client_secret) {
      throw new Error(
        "iap-auth: ADC file is missing refresh_token/client_id/client_secret. " +
          "Run `gcloud auth application-default login`.",
      );
    }
    // Only cache a usable file, so a first-time ENOENT doesn't poison later calls.
    this.cachedCreds = raw;
    return raw;
  }

  /** Exchanges the ADC refresh_token for an access_token (the caller credential). */
  private async fetchCallerAccessToken(): Promise<string> {
    const creds = await this.readCredentials();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token as string,
      client_id: creds.client_id as string,
      client_secret: creds.client_secret as string,
    });
    const res = await this.callWithTimeout(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `iap-auth: ADC refresh_token grant returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const parsed = (await res.json()) as { access_token?: string };
    if (!parsed.access_token) {
      throw new Error("iap-auth: ADC token endpoint returned no access_token");
    }
    return parsed.access_token;
  }

  private async mint(audience: string): Promise<string> {
    const accessToken = await this.fetchCallerAccessToken();
    const url = `${this.iamCredentialsBaseUrl}/projects/-/serviceAccounts/${encodeURIComponent(
      this.targetServiceAccount,
    )}:generateIdToken`;
    const res = await this.callWithTimeout(url, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      // includeEmail so the receiver can pin the principal (oauth-verify's
      // trusted-principals check reads the email claim).
      body: JSON.stringify({ audience, includeEmail: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `iap-auth: iamcredentials.generateIdToken for ${this.targetServiceAccount} returned HTTP ${res.status}: ${text.slice(0, 200)}. ` +
          "Check that you hold roles/iam.serviceAccountTokenCreator on that service account.",
      );
    }
    const parsed = (await res.json()) as { token?: string };
    if (!parsed.token) {
      throw new Error(
        `iap-auth: iamcredentials.generateIdToken for ${this.targetServiceAccount} returned no token`,
      );
    }
    this.cache.set(audience, { token: parsed.token, expiresAt: this.now() + this.cacheTtlMs });
    return parsed.token;
  }

  private async callWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
