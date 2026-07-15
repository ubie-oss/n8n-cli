import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UserTokenSource } from "./user-token-source.ts";

/**
 * Google-specific `UserTokenSource` that reads the Application Default
 * Credentials file (`gcloud auth application-default login` output) and
 * exchanges the user's refresh_token for a fresh id_token via Google's
 * OAuth2 token endpoint.
 *
 * Why this lives separately from `user-token-source.ts`: this file
 * couples to Google's OAuth token endpoint URL, ADC file layout, and
 * refresh_token grant shape. Deployments that don't use Google can pick
 * `StaticUserTokenSource` / `EnvUserTokenSource` and never touch this
 * module. Custom sources implement the `UserTokenSource` interface
 * directly.
 *
 * Not exported through the middleware's factory as a hard default;
 * callers must select it explicitly via `tokenSourceKind: "adc"` on the
 * factory or by injecting an instance into the middleware constructor.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  token: string;
  expiresAt: number;
}

/** Shape of `application_default_credentials.json`. */
export interface AdcUserCredentials {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  quota_project_id?: string;
}

const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_CACHE_TTL_MS = 50 * 60 * 1000; // id_tokens live ~1h

export interface AdcUserTokenSourceDeps {
  fetcher?: FetchLike;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** Explicit override for the credentials file path (testing / non-default install). */
  credentialsPath?: string;
  /** Injected reader for tests — reads the JSON from disk. */
  readCredentials?: () => Promise<AdcUserCredentials>;
  /** Override for the OAuth token endpoint (testing). */
  tokenEndpoint?: string;
}

function defaultAdcPath(): string {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit) return explicit;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, "gcloud", "application_default_credentials.json");
  }
  return join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * Reads on-disk ADC and exchanges the refresh_token for id_tokens via
 * Google's OAuth token endpoint. Caches per-audience with in-flight
 * coalescing.
 *
 * Credential-read failures do NOT poison the source: if the initial
 * read fails (e.g. file not yet created), the next call re-reads. This
 * matters because CLI users often start the process before running
 * `gcloud auth application-default login`.
 */
export class AdcUserTokenSource implements UserTokenSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly credentialsPath: string;
  private readonly tokenEndpoint: string;
  private readonly readCredentialsImpl?: () => Promise<AdcUserCredentials>;
  /** Cached credentials from the last successful disk read. */
  private cachedCreds?: AdcUserCredentials;

  constructor(deps: AdcUserTokenSourceDeps = {}) {
    this.fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? 5_000;
    this.credentialsPath = deps.credentialsPath ?? defaultAdcPath();
    this.tokenEndpoint = deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.readCredentialsImpl = deps.readCredentials;
  }

  async getToken(audience: string): Promise<string> {
    const cached = this.cache.get(audience);
    if (cached && cached.expiresAt > this.now()) return cached.token;
    const inflight = this.inflight.get(audience);
    if (inflight) return inflight;
    const p = this.fetchAndCache(audience).finally(() => this.inflight.delete(audience));
    this.inflight.set(audience, p);
    return p;
  }

  private async readCredentials(): Promise<AdcUserCredentials> {
    if (this.cachedCreds) return this.cachedCreds;
    const raw = this.readCredentialsImpl
      ? await this.readCredentialsImpl()
      : (JSON.parse(await readFile(this.credentialsPath, "utf8")) as AdcUserCredentials);
    // Only cache after successful read — this way a first-time ENOENT
    // doesn't poison future calls made after the user finally runs
    // `gcloud auth application-default login`.
    this.cachedCreds = raw;
    return raw;
  }

  private async fetchAndCache(audience: string): Promise<string> {
    const creds = await this.readCredentials();
    if (!creds.refresh_token || !creds.client_id || !creds.client_secret) {
      throw new Error(
        "impersonator-token: ADC file is missing refresh_token/client_id/client_secret. " +
          "Run `gcloud auth application-default login`.",
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      audience,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetcher(this.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(
        `impersonator-token: refresh_token grant returned HTTP ${res.status}: ${bodyText.slice(0, 200)}`,
      );
    }
    const parsed = (await res.json()) as { id_token?: string; expires_in?: number };
    if (!parsed.id_token) {
      throw new Error("impersonator-token: token endpoint returned no id_token");
    }
    const ttl =
      typeof parsed.expires_in === "number" && parsed.expires_in > 60
        ? (parsed.expires_in - 60) * 1000
        : this.cacheTtlMs;
    this.cache.set(audience, { token: parsed.id_token, expiresAt: this.now() + ttl });
    return parsed.id_token;
  }
}
