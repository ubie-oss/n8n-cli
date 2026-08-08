import { GoogleAuth } from "google-auth-library";
import { type SecretRef, SecretResolveError, type SecretResolver } from "./types.ts";

/** Scheme claimed by this resolver. */
export const GCP_SECRET_MANAGER_SCHEME = "gcp-sm";

/** Scope required to read secret payloads. */
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Version alias used when a reference does not name one. */
const DEFAULT_VERSION = "latest";

const API_BASE = "https://secretmanager.googleapis.com/v1";

/** Shape of the `:access` response, narrowed to the part that carries the value. */
interface AccessSecretVersionResponse {
  payload?: { data?: string };
}

/**
 * Resolves `gcp-sm://` references against Google Cloud Secret Manager, using
 * Application Default Credentials.
 *
 * ADC is the only supported credential source, and deliberately so: it is what
 * `gcloud auth application-default login` sets up on a developer's machine and
 * what a workload identity provides in CI, so the same credential file works in
 * both places with nothing instance-specific committed to the repository. It
 * also means this CLI never reads a service-account key path of its own — if
 * ADC cannot find credentials, that is a matter for the environment, not for a
 * flag here.
 *
 * Calls go to the REST endpoint rather than through `@google-cloud/secret-
 * manager`, because that client pulls in gRPC and protobuf runtimes which would
 * add tens of megabytes to a binary that ships under a size gate — for one GET.
 */
export class GcpSecretManagerResolver implements SecretResolver {
  readonly scheme = GCP_SECRET_MANAGER_SCHEME;
  readonly description = "Google Cloud Secret Manager (Application Default Credentials)";

  /**
   * Values already fetched in this process, keyed by resolved resource name.
   *
   * A credential set commonly points several fields at the same secret, and
   * every lookup is a network round trip plus a Secret Manager access charge.
   * Scoped to one CLI run, so it never becomes a cache anyone has to invalidate.
   */
  private readonly cache = new Map<string, string>();

  private auth?: GoogleAuth;

  constructor(
    /** Injectable for tests; defaults to the real Secret Manager endpoint. */
    private readonly apiBase: string = API_BASE,
    /**
     * Where the bearer token comes from. Injectable so the request, caching and
     * error-reporting behaviour can be exercised without a Google account —
     * otherwise every test of this class would be an integration test against
     * someone's real project.
     */
    private readonly fetchAccessToken: () => Promise<string | null | undefined> = () => {
      this.auth ??= new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
      return this.auth.getAccessToken();
    },
  ) {}

  async resolve(ref: SecretRef): Promise<string> {
    const name = resourceName(ref);

    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    const token = await this.accessToken(ref);

    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/${name}:access`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (err) {
      throw new SecretResolveError(ref, `Secret Manager request failed: ${message(err)}`, err);
    }

    if (!response.ok) {
      throw new SecretResolveError(ref, await describeHttpFailure(response, name));
    }

    let body: AccessSecretVersionResponse;
    try {
      body = (await response.json()) as AccessSecretVersionResponse;
    } catch (err) {
      throw new SecretResolveError(ref, `Secret Manager returned invalid JSON: ${message(err)}`);
    }

    const data = body.payload?.data;
    if (typeof data !== "string") {
      throw new SecretResolveError(ref, `Secret Manager returned no payload for ${name}`);
    }

    // Payloads are arbitrary bytes, base64-encoded on the wire. Decoded as UTF-8
    // because a credential field is a string; a genuinely binary secret has no
    // representation in an n8n credential anyway.
    const value = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    this.cache.set(name, value);
    return value;
  }

  /** Fetches an ADC access token, reusing the auth client across calls. */
  private async accessToken(ref: SecretRef): Promise<string> {
    try {
      const token = await this.fetchAccessToken();
      if (!token) {
        throw new Error("Application Default Credentials produced no access token");
      }
      return token;
    } catch (err) {
      throw new SecretResolveError(
        ref,
        `Google authentication failed: ${message(err)}. ` +
          "Run `gcloud auth application-default login`, or point " +
          "GOOGLE_APPLICATION_CREDENTIALS at a service account with " +
          "roles/secretmanager.secretAccessor.",
        err,
      );
    }
  }
}

/**
 * Turns a reference locator into a Secret Manager resource name.
 *
 * Two spellings are accepted, and the full one is checked first because it is
 * unambiguous: a locator starting with `projects/` is passed through as-is,
 * which lets a user paste what the Google Cloud console shows them. Everything
 * else is the short form, `<project>/<secret>[/<version>]`, which is what a
 * credential file is normally written with.
 */
export function resourceName(ref: SecretRef): string {
  const segments = ref.locator.split("/").filter((s) => s !== "");

  if (segments[0] === "projects") {
    // A pasted resource name may or may not carry a version; default it so both
    // forms mean the same thing as the short spelling does.
    if (segments.length === 4 && segments[2] === "secrets") {
      return `${segments.join("/")}/versions/${DEFAULT_VERSION}`;
    }
    if (segments.length === 6 && segments[2] === "secrets" && segments[4] === "versions") {
      return segments.join("/");
    }
    throw new SecretResolveError(
      ref,
      "expected projects/<project>/secrets/<secret>[/versions/<version>]",
    );
  }

  const [project, secret, version = DEFAULT_VERSION, ...rest] = segments;
  if (!project || !secret || rest.length > 0) {
    throw new SecretResolveError(
      ref,
      `expected ${GCP_SECRET_MANAGER_SCHEME}://<project>/<secret>[/<version>]`,
    );
  }

  return `projects/${project}/secrets/${secret}/versions/${version}`;
}

/**
 * Describes an HTTP failure with the status codes that have a specific cause.
 *
 * The response body is read but only the status drives the wording: Google's
 * error bodies are long, and the three cases below are what actually goes wrong
 * — wrong project, missing grant, or a secret that is not there.
 */
async function describeHttpFailure(response: Response, name: string): Promise<string> {
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 300);
  } catch {
    // The status alone is enough to act on.
  }

  const suffix = detail ? ` (${detail})` : "";
  switch (response.status) {
    case 401:
      return `Secret Manager rejected the credentials (401)${suffix}`;
    case 403:
      return (
        `no access to ${name} (403). The authenticated principal needs ` +
        `roles/secretmanager.secretAccessor on that secret${suffix}`
      );
    case 404:
      return `${name} does not exist (404)${suffix}`;
    default:
      return `Secret Manager returned ${response.status}${suffix}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
