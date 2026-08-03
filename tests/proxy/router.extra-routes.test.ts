import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerFactory, resetRegistry } from "@/middleware/registry.ts";
import type {
  ServerMiddleware,
  ServerMiddlewareContext,
  ServerMiddlewareFactory,
} from "@/middleware/types.ts";
import { registerBuiltins } from "@/middleware/wiring.ts";
import { DEFAULT_ROUTES, matchWorkflowMutation, resolveRouteTable } from "@/proxy/rest/router.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

const TRIGGER_ROUTE = "POST /webhook/__agent-trigger__/:id -> trigger";

describe("resolveRouteTable", () => {
  test("returns undefined when neither knob is set, so callers fall back to defaults", () => {
    expect(resolveRouteTable(undefined, undefined)).toBeUndefined();
  });

  test("--routes alone still replaces the table wholesale", () => {
    const routes = resolveRouteTable("POST /api/v1/only -> only", undefined);
    expect(routes).toEqual([
      { method: "POST", pattern: "/api/v1/only", action: "only", bodyIsWorkflow: false },
    ]);
  });

  test("--extra-routes alone appends to the defaults rather than replacing them", () => {
    const routes = resolveRouteTable(undefined, TRIGGER_ROUTE);
    expect(routes).toHaveLength(DEFAULT_ROUTES.length + 1);
    expect(routes?.slice(0, DEFAULT_ROUTES.length)).toEqual(DEFAULT_ROUTES);
    expect(routes?.at(-1)).toEqual({
      method: "POST",
      pattern: "/webhook/__agent-trigger__/:id",
      action: "trigger",
      bodyIsWorkflow: false,
    });
  });

  test("both knobs together append the extras to the explicit table", () => {
    const routes = resolveRouteTable("POST /api/v1/only -> only", TRIGGER_ROUTE);
    expect(routes?.map((r) => r.action)).toEqual(["only", "trigger"]);
  });

  test("a base route wins a tie, so an extra cannot reclassify a gated endpoint", () => {
    const routes = resolveRouteTable(undefined, "POST /api/v1/workflows -> sneaky");
    const hit = matchWorkflowMutation("POST", "/api/v1/workflows", routes);
    expect(hit?.action).toBe("create");
  });

  test("a malformed extra throws instead of being dropped", () => {
    expect(() => resolveRouteTable(undefined, "not a route")).toThrow(/Invalid proxy route/);
  });

  test("blank extras are ignored", () => {
    expect(resolveRouteTable(undefined, "   ")).toBeUndefined();
  });
});

describe("matchWorkflowMutation with an appended trigger route", () => {
  const routes = resolveRouteTable(undefined, TRIGGER_ROUTE);

  test("matches a trigger webhook path", () => {
    expect(matchWorkflowMutation("POST", "/webhook/__agent-trigger__/abc", routes)).toEqual({
      action: "trigger",
      id: "abc",
      bodyIsWorkflow: false,
    });
  });

  test("leaves other webhook paths transparent", () => {
    expect(matchWorkflowMutation("POST", "/webhook/__cli-test__/abc", routes)).toBeNull();
  });

  test("does not match a GET on the same path", () => {
    expect(matchWorkflowMutation("GET", "/webhook/__agent-trigger__/abc", routes)).toBeNull();
  });

  test("still matches the default workflow routes", () => {
    expect(matchWorkflowMutation("POST", "/api/v1/workflows", routes)?.action).toBe("create");
  });
});

/** Middleware that records every context it judged. */
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

describe("proxy: an appended trigger route runs middleware but stays out of lint's way", () => {
  let upstream: ReturnType<typeof startUpstream>;
  let proxy: ProxyHandle;
  let judged: ServerMiddlewareContext[];

  function startUpstream() {
    const seen: Array<{ method: string; pathname: string; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({
          method: req.method,
          pathname: new URL(req.url).pathname,
          body: await req.text(),
        });
        return new Response(JSON.stringify({ message: "Workflow was started" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    return { server, port: server.port as number, seen };
  }

  beforeEach(() => {
    resetRegistry();
    registerBuiltins();
    judged = [];
    registerFactory(recorder("op-level", judged));
    upstream = startUpstream();
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      // lint blocks anything it judges that is not a workflow definition, so
      // its silence here is the assertion that it was filtered out.
      enforce: "error",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      middlewares: ["op-level", "lint"],
      routes: resolveRouteTable(undefined, TRIGGER_ROUTE),
    });
  });

  afterEach(async () => {
    await proxy?.stop();
    await upstream.server.stop(true);
    resetRegistry();
  });

  test("the trigger call is judged, then forwarded verbatim", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/webhook/__agent-trigger__/abc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"reason":"manual"}',
    });

    expect(res.status).toBe(200);
    expect(judged.map((c) => c.action)).toEqual(["trigger"]);
    // No definition on this route, so nothing should have been handed a body
    // to judge — that is what keeps lint from rejecting it as "not a workflow".
    expect(judged[0]?.rawJSON).toBeUndefined();
    expect(judged[0]?.workflow).toBeNull();
    expect(upstream.seen).toEqual([
      { method: "POST", pathname: "/webhook/__agent-trigger__/abc", body: '{"reason":"manual"}' },
    ]);
  });

  test("an ungated webhook path is forwarded without being judged at all", async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/webhook/__cli-test__/abc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(judged).toHaveLength(0);
  });
});
