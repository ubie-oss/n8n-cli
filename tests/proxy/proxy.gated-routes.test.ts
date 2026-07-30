import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerFactory, resetRegistry } from "@/middleware/registry.ts";
import type {
  ServerMiddleware,
  ServerMiddlewareContext,
  ServerMiddlewareFactory,
} from "@/middleware/types.ts";
import { registerBuiltins } from "@/middleware/wiring.ts";
import { DEFAULT_ROUTES } from "@/proxy/rest/router.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * Every gated route, end to end: what reaches upstream, what each middleware
 * was asked about, and what the client gets back.
 *
 * Covers the case that escaped before: routes carrying no workflow definition
 * were still judged by lint, which then blocked them for not being workflows.
 */

interface Seen {
  method: string;
  pathname: string;
  apiKey: string | null;
}

function startUpstream() {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        pathname: url.pathname,
        apiKey: req.headers.get("x-n8n-api-key"),
      });
      const body =
        url.pathname === "/api/v1/workflows/wf1" && req.method === "GET"
          ? { id: "wf1", name: "stored", nodes: [], connections: {}, tags: [{ name: "zs:team-a" }] }
          : { ok: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port as number, seen };
}

/** Middleware that records the contexts it judged. */
function recorder(name: string, seen: ServerMiddlewareContext[]): ServerMiddlewareFactory<object> {
  return {
    name,
    loadFromEnv: () => ({}),
    loadFromCLI: () => ({}),
    build: (): ServerMiddleware => ({
      name,
      evaluate(ctx) {
        seen.push(ctx);
        return { block: false, violations: [] };
      },
    }),
  };
}

let upstream: ReturnType<typeof startUpstream>;
let proxy: ProxyHandle;
let judged: ServerMiddlewareContext[];

beforeEach(() => {
  resetRegistry();
  registerBuiltins();
  judged = [];
  registerFactory(recorder("op-level", judged));
  upstream = startUpstream();
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    // lint would block anything it judged without a definition.
    enforce: "error",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    middlewares: ["op-level", "lint"],
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

const WORKFLOW = {
  name: "wf",
  nodes: [{ id: "1", name: "n", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [0, 0] }],
  connections: {},
};

describe("proxy: every gated route", () => {
  const cases: Array<{
    label: string;
    method: string;
    path: string;
    body?: unknown;
    action: string;
    expectStatus: number;
  }> = [
    {
      label: "create",
      method: "POST",
      path: "/api/v1/workflows",
      body: WORKFLOW,
      action: "create",
      expectStatus: 200,
    },
    {
      label: "update",
      method: "PUT",
      path: "/api/v1/workflows/wf1",
      body: WORKFLOW,
      action: "update",
      expectStatus: 200,
    },
    {
      label: "tags",
      method: "PUT",
      path: "/api/v1/workflows/wf1/tags",
      body: [{ id: "t1" }],
      action: "tags",
      expectStatus: 200,
    },
    {
      label: "delete",
      method: "DELETE",
      path: "/api/v1/workflows/wf1",
      action: "delete",
      expectStatus: 200,
    },
    {
      label: "activate",
      method: "POST",
      path: "/api/v1/workflows/wf1/activate",
      action: "activate",
      expectStatus: 200,
    },
    {
      label: "deactivate",
      method: "POST",
      path: "/api/v1/workflows/wf1/deactivate",
      action: "activate",
      expectStatus: 200,
    },
  ];

  for (const c of cases) {
    test(`${c.label} reaches upstream and is judged with action=${c.action}`, async () => {
      const res = await fetch(url(c.path), {
        method: c.method,
        headers: { "content-type": "application/json", "x-n8n-api-key": "key" },
        ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
      });

      expect(res.status).toBe(c.expectStatus);
      expect(upstream.seen.map((s) => s.pathname)).toContain(c.path);
      expect(judged).toHaveLength(1);
      expect(judged[0]?.action).toBe(c.action);
    });
  }

  test("the route table used at runtime is the documented default", () => {
    expect(DEFAULT_ROUTES.map((r) => `${r.method} ${r.pattern} ${r.action}`)).toEqual([
      "POST /api/v1/workflows create",
      "PUT /api/v1/workflows/:id update",
      "PUT /api/v1/workflows/:id/tags tags",
      "DELETE /api/v1/workflows/:id delete",
      "POST /api/v1/workflows/:id/activate activate",
      "POST /api/v1/workflows/:id/deactivate activate",
    ]);
  });
});

describe("proxy: what each route hands to middleware", () => {
  test("definition routes carry the parsed workflow and its raw body", async () => {
    await fetch(url("/api/v1/workflows/wf1"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(WORKFLOW),
    });

    expect(judged[0]?.workflow?.name).toBe("wf");
    expect(judged[0]?.rawJSON).toContain('"name":"wf"');
    expect(judged[0]?.workflowId).toBe("wf1");
  });

  test("non-definition routes carry no workflow, and no raw body to lint", async () => {
    await fetch(url("/api/v1/workflows/wf1/tags"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ id: "t1" }]),
    });

    expect(judged[0]?.workflow).toBeNull();
    expect(judged[0]?.rawJSON).toBeUndefined();
    // The target is still identified, so an ACL can be looked up for it.
    expect(judged[0]?.workflowId).toBe("wf1");
  });

  test("a malformed definition is still rejected before upstream", async () => {
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(400);
    expect(upstream.seen).toEqual([]);
  });

  test("a definition violating an error-level rule is still blocked", async () => {
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodes: [], connections: {} }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "workflow_lint_failed" });
    expect(upstream.seen).toEqual([]);
  });

  test("stored state is readable for the routes that have no body", async () => {
    let stored: unknown;
    resetRegistry();
    registerBuiltins();
    registerFactory({
      name: "acl-reader",
      loadFromEnv: () => ({}),
      loadFromCLI: () => ({}),
      build: (): ServerMiddleware => ({
        name: "acl-reader",
        async evaluate(ctx) {
          stored = await ctx.fetchStoredWorkflow?.(ctx.workflowId as string);
          return { block: false, violations: [] };
        },
      }),
    });
    await proxy.stop();
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "error",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      middlewares: ["acl-reader", "lint"],
    });

    const res = await fetch(url("/api/v1/workflows/wf1"), {
      method: "DELETE",
      headers: { "x-n8n-api-key": "caller-key" },
    });

    expect(res.status).toBe(200);
    expect((stored as { tags?: Array<{ name: string }> })?.tags?.[0]?.name).toBe("zs:team-a");
    // The lookup runs under the caller's own key, not an escalated one.
    const lookup = upstream.seen.find(
      (s) => s.method === "GET" && s.pathname === "/api/v1/workflows/wf1",
    );
    expect(lookup?.apiKey).toBe("caller-key");
  });
});

describe("proxy: ungated paths are untouched", () => {
  const passthrough: Array<[string, string]> = [
    ["GET", "/api/v1/workflows"],
    ["GET", "/api/v1/workflows/wf1"],
    ["GET", "/api/v1/tags"],
    ["POST", "/api/v1/tags"],
    ["GET", "/api/v1/executions"],
    ["POST", "/api/v1/credentials"],
  ];

  for (const [method, path] of passthrough) {
    test(`${method} ${path} is forwarded without any verdict`, async () => {
      const res = await fetch(url(path), {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ name: "x" }) } : {}),
      });

      expect(res.status).toBe(200);
      expect(judged).toHaveLength(0);
      expect(upstream.seen.map((s) => s.pathname)).toContain(path);
    });
  }
});
