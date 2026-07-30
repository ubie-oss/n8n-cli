import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerFactory, resetRegistry } from "@/middleware/registry.ts";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { registerBuiltins } from "@/middleware/wiring.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * Routes that are gated but carry no workflow definition: tag assignment,
 * delete, activate.
 *
 * These exist so an ACL kept in tags can actually be defended — gating the
 * workflow body while leaving `PUT /workflows/:id/tags` open would be
 * decoration. But they must not be judged by middleware whose subject is the
 * definition: `apply` assigns tags on every write, so lint blocking an empty
 * body there breaks every apply that carries a tag.
 */

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  seen: Array<{ method: string; pathname: string }>;
}

function startMockUpstream(): MockUpstream {
  const seen: Array<{ method: string; pathname: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, pathname: url.pathname });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port!, seen };
}

/** Records which routes an operation-level middleware was asked about. */
function recordingAuthzFactory(seen: Array<string | undefined>): ServerMiddlewareFactory<object> {
  return {
    name: "recording-authz",
    loadFromEnv: () => ({}),
    loadFromCLI: () => ({}),
    build: () => ({
      name: "recording-authz",
      evaluate(ctx) {
        seen.push(ctx.action);
        return { block: false, violations: [] };
      },
    }),
  };
}

let upstream: MockUpstream;
let proxy: ProxyHandle;
let authzSaw: Array<string | undefined>;

beforeEach(() => {
  resetRegistry();
  registerBuiltins();
  authzSaw = [];
  registerFactory(recordingAuthzFactory(authzSaw));
  upstream = startMockUpstream();
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    // enforce=error is the interesting setting: lint would block if it ran.
    enforce: "error",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    middlewares: ["recording-authz", "lint"],
  });
});

afterEach(async () => {
  await proxy?.stop();
  await upstream.server.stop(true);
  resetRegistry();
});

function url(p: string): string {
  return `http://127.0.0.1:${proxy.port}${p}`;
}

describe("proxy: gated routes without a workflow body", () => {
  test("tag assignment is forwarded, not linted as an empty workflow", async () => {
    const res = await fetch(url("/api/v1/workflows/wf1/tags"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: "tag1" }]),
    });

    expect(res.status).toBe(200);
    expect(upstream.seen).toEqual([{ method: "PUT", pathname: "/api/v1/workflows/wf1/tags" }]);
    // Still authorized — the operation-level middleware saw the route.
    expect(authzSaw).toEqual(["tags"]);
  });

  test("delete is forwarded and still authorized", async () => {
    const res = await fetch(url("/api/v1/workflows/wf1"), { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(authzSaw).toEqual(["delete"]);
  });

  test("activate is forwarded and still authorized", async () => {
    const res = await fetch(url("/api/v1/workflows/wf1/activate"), { method: "POST" });

    expect(res.status).toBe(200);
    expect(authzSaw).toEqual(["activate"]);
  });

  test("a workflow write is still linted — the skip is per route, not global", async () => {
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Well-formed enough to lint, but missing `name`: required-fields is
      // error by default.
      body: JSON.stringify({ nodes: [], connections: {} }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "workflow_lint_failed" });
    expect(upstream.seen).toEqual([]);
    expect(authzSaw).toEqual(["create"]);
  });
});
