/**
 * Forwards a Request to the upstream n8n server transparently.
 *
 * Strips RFC 7230 §6.1 hop-by-hop headers (`Connection`, `Keep-Alive`, `TE`,
 * `Transfer-Encoding`, `Trailer`, `Upgrade`, `Proxy-Authorization`,
 * `Proxy-Authenticate`) plus any header named in the incoming `Connection:`
 * header, and the original `Host` header (it would carry the proxy's host into
 * the upstream call). `Content-Length` is also stripped because fetch
 * recomputes it from the actual body.
 *
 * Preserves auth headers including `X-N8N-API-KEY` and `Authorization` since
 * the client is expected to supply them and the upstream needs them to
 * authenticate.
 */

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
  return headers;
}

export interface ForwardOptions {
  /** Total request timeout in milliseconds; 0 disables timeout. */
  timeoutMs?: number;
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
    return { response, elapsedMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
