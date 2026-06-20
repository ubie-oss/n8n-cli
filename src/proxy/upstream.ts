/**
 * Forwards a Request to the upstream n8n server transparently.
 *
 * Strips hop-by-hop headers and the original `host` header (it would carry the
 * proxy's host into the upstream call). Preserves auth headers including
 * `X-N8N-API-KEY` since the client is expected to supply them and the upstream
 * needs them to authenticate.
 */
export async function forwardRequest(
  req: Request,
  upstreamBase: string,
  body?: string | ArrayBuffer | null,
): Promise<{ response: Response; elapsedMs: number }> {
  const incomingUrl = new URL(req.url);
  const upstreamUrl = `${upstreamBase}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

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

  const start = performance.now();
  const response = await fetch(upstreamUrl, init);
  const elapsedMs = Math.round(performance.now() - start);
  return { response, elapsedMs };
}
