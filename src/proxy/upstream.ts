/**
 * Forwards a Request to the upstream n8n server transparently.
 *
 * Strips RFC 7230 §6.1 hop-by-hop headers (`Connection`, `Keep-Alive`, `TE`,
 * `Transfer-Encoding`, `Trailer`, `Upgrade`, `Proxy-Authorization`,
 * `Proxy-Authenticate`) plus any header named in the incoming `Connection:`
 * header, and the original `Host` header (it would carry the proxy's host into
 * the upstream call). `Content-Length` is also stripped because fetch
 * recomputes it from the actual body, and so are the proxy's own control
 * headers (see `@/api/headers.ts`), which n8n has no use for.
 *
 * Preserves auth headers (`X-N8N-API-KEY`, `Authorization`) by default — the
 * client is expected to supply them and the upstream needs them to
 * authenticate. The exception is a chain containing a middleware that claims
 * the credential headers (see `headerClaims`): there the proxy holds the
 * upstream credentials, so the client's `Authorization` is dropped before the
 * chain runs. Client middlewares (see `ClientMiddleware`) execute after the
 * strip step and before fetch.
 *
 * On the way back, `Content-Encoding` (and the now-stale `Content-Length`) are
 * dropped from the upstream response — see `normalizeResponseEncoding`.
 */
import { BASE_UPDATED_AT_HEADER } from "@/api/headers.ts";
import { runClientPipeline } from "@/middleware/client-pipeline.ts";
import { claimCoversPath } from "@/middleware/header-claims.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";

/**
 * Headers the proxy consumes itself. They address this hop, not n8n, so they
 * are dropped for the same reason hop-by-hop headers are.
 */
const PROXY_CONTROL_HEADERS = [BASE_UPDATED_AT_HEADER.toLowerCase()];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function buildUpstreamHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);

  // Any header name listed in `Connection:` is also hop-by-hop per RFC 7230.
  const connection = headers.get("connection");
  if (connection) {
    for (const name of connection.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) headers.delete(trimmed);
    }
  }

  for (const h of HOP_BY_HOP_HEADERS) {
    headers.delete(h);
  }
  for (const h of PROXY_CONTROL_HEADERS) {
    headers.delete(h);
  }
  return headers;
}

/**
 * Rebuilds an upstream response so its headers describe the body we actually
 * hand downstream.
 *
 * `fetch` negotiates and transparently *decodes* the response body (the
 * outgoing request carries an `Accept-Encoding` the runtime adds on its own),
 * but the `Response` it returns still advertises the upstream's
 * `Content-Encoding` and the compressed `Content-Length`. Forwarding those
 * verbatim hands the client a plain body labelled `content-encoding: br`,
 * which any client that honours the header fails to decode — n8n-cli's own
 * API client dies with `BrotliDecompressionError`. curl only escapes this
 * because it doesn't ask for compression by default.
 *
 * So: when the upstream declares a real content coding, strip both headers and
 * let the runtime recompute the length. Responses without an encoding (or with
 * `identity`) pass through untouched, keeping the original object — and its
 * mutable headers, which `handleWorkflowMutation` relies on to attach lint
 * counters.
 */
function normalizeResponseEncoding(response: Response): Response {
  const encoding = response.headers.get("content-encoding");
  if (!encoding || encoding.trim().toLowerCase() === "identity") return response;

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  // Stale: it measures the compressed bytes, not the decoded body we forward.
  headers.delete("content-length");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Headers that carry the credential for one hop of the chain. When a
 * middleware claims either of them, the proxy — not the caller — is the one
 * holding upstream credentials, and the caller's `Authorization` is dropped.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization"]);

/**
 * Whether the chain supplies a credential header for this particular path.
 *
 * Where nothing claims one, the proxy is a transparent forwarder as far as auth
 * goes: the caller may legitimately be authenticating to n8n itself (webhook
 * nodes using header or basic auth), nothing in front of it consumed that
 * header, and discarding it would break the request. The check is per-path
 * because claims are — a rule scoped to `/mcp-server/` says nothing about what
 * should happen to `/webhook/`.
 */
function chainSuppliesCredentials(chain: ClientMiddleware[], pathname: string): boolean {
  return chain.some((m) =>
    m.headerClaims?.some(
      (c) => CREDENTIAL_HEADERS.has(c.header.toLowerCase()) && claimCoversPath(c, pathname),
    ),
  );
}

export interface ForwardOptions {
  /** Total request timeout in milliseconds; 0 disables timeout. */
  timeoutMs?: number;
  /**
   * Ordered list of client middlewares to apply to the outgoing request,
   * after hop-by-hop stripping and before fetch. Each middleware can mutate
   * the outgoing Headers (e.g. mint an IAP id_token, inject a shared n8n
   * API key, propagate a trace header).
   *
   * A middleware that throws aborts the upstream fetch — the caller sees
   * the error and translates it into a 502.
   */
  clientMiddlewares?: ClientMiddleware[];
}

export async function forwardRequest(
  req: Request,
  upstreamBase: string,
  body?: string | ArrayBuffer | null,
  options?: ForwardOptions,
): Promise<{ response: Response; elapsedMs: number }> {
  const incomingUrl = new URL(req.url);
  const upstreamUrl = `${upstreamBase}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = buildUpstreamHeaders(req);

  const clientMiddlewares = options?.clientMiddlewares ?? [];
  if (clientMiddlewares.length > 0) {
    if (chainSuppliesCredentials(clientMiddlewares, incomingUrl.pathname)) {
      // The client's `Authorization` addresses *this* hop, not the upstream, so
      // it is dropped for the same reason hop-by-hop headers are — and before
      // the pipeline, so a middleware that sets it still wins.
      //
      // Two reasons it must not travel on. It is a credential for reaching the
      // proxy and stays replayable until it expires, so letting it land in the
      // upstream's logs leaks the right to call this proxy. And where the proxy
      // fronts an IAP-protected backend, the client's token carries a different
      // `aud` than the backend's IAP expects, so forwarding it only produces
      // audience-mismatch 401s at the second hop.
      //
      // Doing this here rather than inside a middleware keeps the outcome
      // independent of chain order: middlewares only ever add.
      headers.delete("authorization");
    }
    await runClientPipeline(clientMiddlewares, headers, {
      request: req,
      method: req.method,
      pathname: incomingUrl.pathname,
      upstreamUrl,
    });
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (body !== undefined) {
    init.body = body;
  } else if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs)
      : null;
  if (controller) init.signal = controller.signal;

  const start = performance.now();
  try {
    const response = await fetch(upstreamUrl, init);
    const elapsedMs = Math.round(performance.now() - start);
    return { response: normalizeResponseEncoding(response), elapsedMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
