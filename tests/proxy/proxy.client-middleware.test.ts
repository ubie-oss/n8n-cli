import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerClientFactory,
  resetClientRegistry,
} from "@/middleware/client-registry.ts";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

interface Captured {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: Captured[];
}

function startMockUpstream(): MockUpstream {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({ method: req.method, pathname: url.pathname, headers, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port!, captured };
}

/**
 * Fake client middleware factory that injects two headers — one constant, one
 * derived from the incoming request's pathname — so tests can prove the
 * pipeline ran on the actual forwarded request.
 */
function makeFakeClientFactory(): ClientMiddlewareFactory<{ value?: string }> {
  return {
    name: "fake-inject",
    loadFromEnv: (env) => ({ value: env.FAKE_INJECT_VALUE }),
    loadFromCLI: (opts) =>
      typeof opts.fakeInjectValue === "string" ? { value: opts.fakeInjectValue as string } : {},
    build: (opts) => {
      const o = opts as { value?: string };
      return {
        name: "fake-inject",
        apply(headers, ctx) {
          headers.set("X-Injected", o.value ?? "default-value");
          headers.set("X-Saw-Path", ctx.pathname);
        },
      };
    },
  };
}

let upstream: MockUpstream;
let proxy: ProxyHandle;

beforeEach(() => {
  resetClientRegistry();
  upstream = startMockUpstream();
});

afterEach(async () => {
  await proxy?.stop();
  await upstream.server.stop(true);
  resetClientRegistry();
});

describe("proxy: client middleware injection", () => {
  test("transparent GET sees injected headers", async () => {
    registerClientFactory(makeFakeClientFactory());
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      clientMiddlewares: ["fake-inject"],
      clientMiddlewareCliOptions: { fakeInjectValue: "transparent" },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, {
      method: "GET",
      headers: { "x-n8n-api-key": "test-key" },
    });
    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    const cap = upstream.captured[0]!;
    expect(cap.headers["x-injected"]).toBe("transparent");
    expect(cap.headers["x-saw-path"]).toBe("/api/v1/workflows");
    // Original auth headers are preserved alongside the injected ones.
    expect(cap.headers["x-n8n-api-key"]).toBe("test-key");
  });

  test("workflow create (mutation) also sees injected headers", async () => {
    registerClientFactory(makeFakeClientFactory());
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      clientMiddlewares: ["fake-inject"],
      clientMiddlewareCliOptions: { fakeInjectValue: "mutation" },
    });

    const body = JSON.stringify({
      name: "wf",
      nodes: [{ id: "1", name: "n", type: "noop", position: [0, 0], typeVersion: 1 }],
      connections: {},
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]!.headers["x-injected"]).toBe("mutation");
  });

  test("a throwing middleware turns the upstream call into 502", async () => {
    const failing: ClientMiddlewareFactory<unknown> = {
      name: "boom",
      loadFromEnv: () => ({}),
      loadFromCLI: () => ({}),
      build: () => ({
        name: "boom",
        apply() {
          throw new Error("token mint failed");
        },
      }),
    };
    registerClientFactory(failing);
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      clientMiddlewares: ["boom"],
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`);
    expect(res.status).toBe(502);
    // The upstream was never reached.
    expect(upstream.captured).toHaveLength(0);
  });

  test("multiple middlewares run in order; later wins on header conflicts", async () => {
    const first: ClientMiddlewareFactory<unknown> = {
      name: "first",
      loadFromEnv: () => ({}),
      loadFromCLI: () => ({}),
      build: () => ({
        name: "first",
        apply(h) {
          h.set("X-Order", "first");
          h.set("X-First-Only", "yes");
        },
      }),
    };
    const second: ClientMiddlewareFactory<unknown> = {
      name: "second",
      loadFromEnv: () => ({}),
      loadFromCLI: () => ({}),
      build: () => ({
        name: "second",
        apply(h) {
          h.set("X-Order", "second");
        },
      }),
    };
    registerClientFactory(first);
    registerClientFactory(second);
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      clientMiddlewares: ["first", "second"],
    });

    await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]!.headers["x-order"]).toBe("second");
    expect(upstream.captured[0]!.headers["x-first-only"]).toBe("yes");
  });
});
