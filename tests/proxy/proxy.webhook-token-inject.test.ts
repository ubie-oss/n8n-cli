import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { webhookTokenInjectFactory } from "@/middleware/builtin/webhook-token-inject/factory.ts";
import { registerClientFactory, resetClientRegistry } from "@/middleware/client-registry.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * End-to-end cover for the property the whole design rests on: webhook paths
 * are *transparently forwarded* (they match no mutation route), and client
 * middleware still runs on that path. If that ever stopped being true, the
 * proxy would forward webhook calls without their token and every gateway-only
 * caller would start getting 403s from n8n — with nothing in this repo failing.
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

const RULES = JSON.stringify([
  {
    pathPrefix: "/webhook/agent-family/",
    header: "x-agent-token",
    token: "agent-secret",
    conflictPolicy: "replace",
  },
  {
    pathPrefix: "/webhook/test-family/",
    header: "x-test-token",
    token: "test-secret",
    conflictPolicy: "set-if-absent",
  },
]);

let upstream: ReturnType<typeof startMockUpstream>;
let proxy: ProxyHandle;

function start(): void {
  registerClientFactory(webhookTokenInjectFactory);
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    clientMiddlewares: ["webhook-token-inject"],
    clientMiddlewareCliOptions: { webhookTokenInjectRules: RULES },
  });
}

beforeEach(() => {
  resetClientRegistry();
  upstream = startMockUpstream();
});

afterEach(async () => {
  await proxy?.stop();
  await upstream.server.stop(true);
  resetClientRegistry();
});

describe("proxy: webhook-token-inject", () => {
  test("a transparently forwarded webhook call arrives with its token", async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/webhook/agent-family/abc-123`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]!.headers["x-agent-token"]).toBe("agent-secret");
  });

  test("each webhook family gets only its own token", async () => {
    start();
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/test-family/abc`, {
      method: "POST",
      body: "{}",
    });
    const cap = upstream.captured[0]!;
    expect(cap.headers["x-test-token"]).toBe("test-secret");
    expect(cap.headers["x-agent-token"]).toBeUndefined();
  });

  test("an unconfigured webhook path carries no token at all", async () => {
    start();
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/unrelated/abc`, {
      method: "POST",
      body: "{}",
    });
    const cap = upstream.captured[0]!;
    expect(cap.headers["x-agent-token"]).toBeUndefined();
    expect(cap.headers["x-test-token"]).toBeUndefined();
  });

  test("the REST API surface never receives a webhook token", async () => {
    start();
    await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, {
      method: "GET",
      headers: { "x-n8n-api-key": "test-key" },
    });
    const cap = upstream.captured[0]!;
    expect(cap.headers["x-agent-token"]).toBeUndefined();
    expect(cap.headers["x-test-token"]).toBeUndefined();
    expect(cap.headers["x-n8n-api-key"]).toBe("test-key");
  });

  test("replace overrides a token the caller brought", async () => {
    start();
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/agent-family/abc`, {
      method: "POST",
      headers: { "x-agent-token": "caller-owned" },
      body: "{}",
    });
    expect(upstream.captured[0]!.headers["x-agent-token"]).toBe("agent-secret");
  });

  test("set-if-absent lets a caller keep bringing its own token during a migration", async () => {
    start();
    await fetch(`http://127.0.0.1:${proxy.port}/webhook/test-family/abc`, {
      method: "POST",
      headers: { "x-test-token": "caller-owned" },
      body: "{}",
    });
    expect(upstream.captured[0]!.headers["x-test-token"]).toBe("caller-owned");
  });
});
