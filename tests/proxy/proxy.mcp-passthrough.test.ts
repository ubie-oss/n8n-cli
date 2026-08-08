import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiKeyInjectFactory } from "@/middleware/builtin/api-key-inject/factory.ts";
import { bearerTokenInjectFactory } from "@/middleware/builtin/bearer-token-inject/factory.ts";
import { iapAuthFactory } from "@/middleware/builtin/iap-auth/factory.ts";
import { registerClientFactory, resetClientRegistry } from "@/middleware/client-registry.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * End-to-end cover for the header split that lets an application-layer bearer
 * token survive a gateway that authenticates with `Authorization` itself.
 *
 * The gateway (Google IAP) accepts its id_token in `Proxy-Authorization` and
 * then forwards `Authorization` to the backend unread, so:
 *   Proxy-Authorization → gateway,  Authorization → the application.
 *
 * These tests assert the shape of the request that leaves the proxy — including
 * that a token the *caller* put in `Authorization` never reaches the upstream,
 * whatever order the chain is configured in.
 */

interface Captured {
  pathname: string;
  headers: Record<string, string>;
}

function startMockUpstream(): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({ pathname: url.pathname, headers });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port!, captured };
}

const MCP_RULES = JSON.stringify([{ pathPrefix: "/mcp-server/", token: "mcp-secret" }]);

let upstream: ReturnType<typeof startMockUpstream>;
let proxy: ProxyHandle;

function start(chain: string[]): void {
  registerClientFactory(iapAuthFactory);
  registerClientFactory(apiKeyInjectFactory);
  registerClientFactory(bearerTokenInjectFactory);
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    clientMiddlewares: chain,
    clientMiddlewareCliOptions: {
      iapAuthAudience: "https://example.com/gateway",
      iapAuthTokenSource: "env",
      iapAuthTokenEnvVar: "TEST_IAP_ID_TOKEN",
      iapAuthHeaderName: "proxy-authorization",
      apiKeyInjectKeyEnvVar: "TEST_N8N_API_KEY",
      bearerTokenInjectRules: MCP_RULES,
    },
  });
}

beforeEach(() => {
  resetClientRegistry();
  upstream = startMockUpstream();
  process.env.TEST_N8N_API_KEY = "api-key-value";
  process.env.TEST_IAP_ID_TOKEN = "iap-id-token";
});

afterEach(async () => {
  await proxy?.stop();
  await upstream.server.stop(true);
  resetClientRegistry();
  delete process.env.TEST_N8N_API_KEY;
  delete process.env.TEST_IAP_ID_TOKEN;
});

describe("proxy: MCP header split", () => {
  test("an MCP call arrives with the gateway token and the app token on separate headers", async () => {
    start(["iap-auth", "api-key-inject", "bearer-token-inject"]);
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(200);
    const cap = upstream.captured[0]!;
    expect(cap.pathname).toBe("/mcp-server/http");
    expect(cap.headers.authorization).toBe("Bearer mcp-secret");
    expect(cap.headers["proxy-authorization"]).toBe("Bearer iap-id-token");
  });

  test("the chain order does not change the result", async () => {
    start(["bearer-token-inject", "api-key-inject", "iap-auth"]);
    await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`, {
      method: "POST",
      body: "{}",
    });
    const cap = upstream.captured[0]!;
    expect(cap.headers.authorization).toBe("Bearer mcp-secret");
    expect(cap.headers["proxy-authorization"]).toBe("Bearer iap-id-token");
  });

  test("a token the caller brought in Authorization never reaches the upstream", async () => {
    start(["iap-auth", "api-key-inject", "bearer-token-inject"]);
    await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`, {
      method: "POST",
      headers: { authorization: "Bearer caller-token-for-this-hop" },
      body: "{}",
    });
    expect(upstream.captured[0]!.headers.authorization).toBe("Bearer mcp-secret");
  });

  test("a caller's Authorization is dropped even on paths no injection rule covers", async () => {
    start(["iap-auth", "api-key-inject", "bearer-token-inject"]);
    await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, {
      method: "GET",
      headers: { authorization: "Bearer caller-token-for-this-hop" },
    });
    const cap = upstream.captured[0]!;
    // Nothing set it on this path, and the caller's value was discarded.
    expect(cap.headers.authorization).toBeUndefined();
    expect(cap.headers["proxy-authorization"]).toBe("Bearer iap-id-token");
    expect(cap.headers["x-n8n-api-key"]).toBe("api-key-value");
  });

  test("a Proxy-Authorization the caller brought is stripped, not forwarded", async () => {
    start(["iap-auth", "api-key-inject", "bearer-token-inject"]);
    await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`, {
      method: "POST",
      headers: { "proxy-authorization": "Bearer smuggled-gateway-token" },
      body: "{}",
    });
    // Hop-by-hop strip runs before the pipeline, so only the proxy's own token
    // survives — a caller cannot ride its own credential past the gateway.
    expect(upstream.captured[0]!.headers["proxy-authorization"]).toBe("Bearer iap-id-token");
  });

  test("the REST API surface still works while the split is on", async () => {
    start(["iap-auth", "api-key-inject", "bearer-token-inject"]);
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, { method: "GET" });
    expect(res.status).toBe(200);
    const cap = upstream.captured[0]!;
    // The public API authenticates on X-N8N-API-KEY and never reads
    // Authorization, so freeing that header up costs it nothing.
    expect(cap.headers["x-n8n-api-key"]).toBe("api-key-value");
    expect(cap.headers.authorization).toBeUndefined();
  });

  test("the MCP token stays off every other path", async () => {
    start(["iap-auth", "api-key-inject", "bearer-token-inject"]);
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/anything`, { method: "POST", body: "{}" });
    expect(upstream.captured[0]!.headers.authorization).toBeUndefined();
  });
});

describe("proxy: chains that claim no credential header", () => {
  function startWithout(chain: string[]): void {
    registerClientFactory(apiKeyInjectFactory);
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      clientMiddlewares: chain,
      clientMiddlewareCliOptions: { apiKeyInjectKeyEnvVar: "TEST_N8N_API_KEY" },
    });
  }

  test("no chain at all keeps the caller's Authorization", async () => {
    startWithout([]);
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/basic-auth-node`, {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
      body: "{}",
    });
    expect(upstream.captured[0]!.headers.authorization).toBe("Basic dXNlcjpwYXNz");
  });

  test("api-key-inject alone keeps it too — it never claimed that header", async () => {
    // Regression guard for deployments that proxy webhook URLs whose nodes use
    // header or basic auth: dropping Authorization for them would turn every
    // such webhook into a 401 on upgrade.
    startWithout(["api-key-inject"]);
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/basic-auth-node`, {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
      body: "{}",
    });
    const cap = upstream.captured[0]!;
    expect(cap.headers.authorization).toBe("Basic dXNlcjpwYXNz");
    expect(cap.headers["x-n8n-api-key"]).toBe("api-key-value");
  });
});

describe("proxy: chains that would fight over one header", () => {
  test("iap-auth in its default mode plus bearer-token-inject is refused at startup", () => {
    registerClientFactory(iapAuthFactory);
    registerClientFactory(bearerTokenInjectFactory);
    expect(() =>
      startProxy({
        listen: "127.0.0.1:0",
        upstream: `http://127.0.0.1:${upstream.port}`,
        enforce: "off",
        disableRules: [],
        logFormat: "json",
        allowDuplicates: true,
        clientMiddlewares: ["bearer-token-inject", "iap-auth"],
        clientMiddlewareCliOptions: {
          iapAuthAudience: "https://example.com/gateway",
          iapAuthTokenSource: "env",
          iapAuthTokenEnvVar: "TEST_IAP_ID_TOKEN",
          // headerName left at its default, so both want `authorization`.
          bearerTokenInjectRules: MCP_RULES,
        },
      }),
    ).toThrow(/both write the "authorization" header/);
  });
});
