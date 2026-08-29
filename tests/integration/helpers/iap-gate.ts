/**
 * A stand-in for Google IAP in front of the n8n-cli proxy.
 *
 * Production folder-read looks like:
 *
 *   CLI (iap-auth) → IAP → proxy (bearer-token-inject on /mcp-server/) → n8n MCP
 *
 * The existing CLI→proxy→mock stack never had this front door, so
 * `import --mcp` could succeed in CI while MCP calls 403'd against a real
 * IAP-protected proxy. This gate is the missing hop: HTML 403 unless
 * `Proxy-Authorization` carries the expected id_token, then the request is
 * forwarded with that hop-by-hop header stripped — the same split IAP
 * documents.
 */

export interface IapGateCapture {
  method: string;
  pathname: string;
  hasIap: boolean;
  hasImpersonator: boolean;
  authorization?: string;
}

export interface IapGate {
  port: number;
  url: string;
  captured: IapGateCapture[];
  stop: () => Promise<void>;
}

export function startIapGate(opts: {
  upstream: string;
  token: string;
  /** Header IAP authenticates on. Default matches N8N_IAP_AUTH_HEADER_NAME=proxy-authorization. */
  headerName?: string;
}): IapGate {
  const headerName = opts.headerName ?? "proxy-authorization";
  const captured: IapGateCapture[] = [];
  const upstream = opts.upstream.replace(/\/+$/, "");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const provided = req.headers.get(headerName);
      const hasIap = provided === `Bearer ${opts.token}`;
      const authorization = req.headers.get("authorization") ?? undefined;
      captured.push({
        method: req.method,
        pathname: url.pathname,
        hasIap,
        hasImpersonator: Boolean(req.headers.get("x-impersonator-id-token")),
        ...(authorization ? { authorization } : {}),
      });

      if (!hasIap) {
        // Google IAP answers HTML, not JSON — that is what the production
        // failure looked like (`MCP request unauthorized (HTTP 403): <html>…`).
        return new Response(
          "<html><head><title>403 Forbidden</title></head><body>Invalid IAP credentials.</body></html>",
          { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } },
        );
      }

      const headers = new Headers(req.headers);
      headers.delete(headerName);
      headers.delete("host");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      headers.delete("connection");

      const target = `${upstream}${url.pathname}${url.search}`;
      const body =
        req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
      });
    },
  });

  return {
    port: server.port!,
    url: `http://127.0.0.1:${server.port}`,
    captured,
    stop: () => server.stop(true),
  };
}
