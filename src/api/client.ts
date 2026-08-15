import { runClientPipeline } from "@/middleware/client-pipeline.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";
import { NetworkError, parseAPIError } from "./errors.ts";

/** Client is the n8n API client */
export class Client {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly clientMiddlewares: ClientMiddleware[];

  constructor(
    baseURL: string,
    apiKey: string,
    timeoutMs = 30_000,
    /**
     * Outgoing middlewares applied to every API call, in order. Empty by
     * default, so a client talking straight to n8n behaves exactly as before.
     *
     * This is the seam that lets the CLI reach an authenticating gateway in
     * front of n8n: such a gateway needs a per-request credential (a
     * short-lived id_token, a user identity side-header), and without a hook
     * here the CLI can only ever send `X-N8N-API-KEY` — so it is rejected at
     * the edge before any n8n request happens. The middlewares are the same
     * ones the proxy subcommand uses on its own egress, so there is one
     * implementation and one config vocabulary for both directions.
     */
    clientMiddlewares: ClientMiddleware[] = [],
  ) {
    // Ensure baseURL doesn't have trailing slash
    let url = baseURL.replace(/\/+$/, "");

    // If base URL already includes /api/v1, don't add it again
    if (!url.endsWith("/api/v1")) {
      url = `${url}/api/v1`;
    }

    this.baseURL = url;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.clientMiddlewares = clientMiddlewares;
  }

  /** doRequest performs an HTTP request with authentication */
  private async doRequest(
    method: string,
    path: string,
    body?: unknown,
    /**
     * Extra headers for this one call, set before the client middlewares run
     * so a middleware can still override them. Used for proxy control headers
     * that only apply to specific operations (see `@/api/headers.ts`).
     */
    extraHeaders?: Record<string, string>,
  ): Promise<string> {
    const url = `${this.baseURL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers({
        "X-N8N-API-KEY": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Ask for an identity encoding on purpose. A proxy in front of n8n
        // typically re-emits the upstream's Content-Encoding over a body its
        // own HTTP client already decoded, and the mismatch surfaces here as a
        // decompression failure we cannot recover from. Uncompressed transfers
        // cost bandwidth a CLI can afford; a read path that dies on large
        // responses is not.
        "Accept-Encoding": "identity",
      });

      for (const [name, value] of Object.entries(extraHeaders ?? {})) {
        headers.set(name, value);
      }

      if (this.clientMiddlewares.length > 0) {
        await runClientPipeline(this.clientMiddlewares, headers, {
          method,
          pathname: new URL(url).pathname,
          upstreamUrl: url,
        });
      }

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      let resp: Response;
      try {
        resp = await fetch(url, init);
      } catch (err) {
        throw new NetworkError(err instanceof Error ? err : new Error(String(err)));
      }

      const respBody = await resp.text();

      if (resp.status >= 400) {
        throw parseAPIError(resp.status, respBody);
      }

      return respBody;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Get performs a GET request */
  async get(path: string): Promise<string> {
    return this.doRequest("GET", path);
  }

  /** Post performs a POST request */
  async post(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<string> {
    return this.doRequest("POST", path, body, extraHeaders);
  }

  /** Put performs a PUT request */
  async put(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<string> {
    return this.doRequest("PUT", path, body, extraHeaders);
  }

  /** Patch performs a PATCH request */
  async patch(path: string, body?: unknown): Promise<string> {
    return this.doRequest("PATCH", path, body);
  }

  /** Delete performs a DELETE request */
  async delete(path: string): Promise<string> {
    return this.doRequest("DELETE", path);
  }
}
