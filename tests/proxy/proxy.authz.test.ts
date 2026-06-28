import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * End-to-end tests for the proxy with the authz middleware enabled.
 *
 * Stands up two local Bun.serve instances:
 *   - fake upstream n8n: records what it received
 *   - fake groups API:   identity → groups[] lookup
 *
 * The proxy is then started in front of upstream and the request goes
 * `client → proxy → (authz hits groups API) → upstream`. Tests assert on
 * both the proxy response and whether upstream was actually called.
 */

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: { method: string; path: string; body: string }[];
}

function startMockUpstream(): MockUpstream {
  const captured: { method: string; path: string; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      captured.push({ method: req.method, path: url.pathname, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port as number, captured };
}

interface MockGroups {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  hits: { body: string; authHeader: string | null }[];
  /** Identity (string parsed out of body.email) → groups[]. */
  table: Map<string, string[]>;
  /** When set, every response is a 5xx — used to test onError handling. */
  failNext: boolean;
}

function startMockGroups(): MockGroups {
  const hits: { body: string; authHeader: string | null }[] = [];
  const state: { table: Map<string, string[]>; failNext: boolean } = {
    table: new Map(),
    failNext: false,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      hits.push({ body, authHeader: req.headers.get("authorization") });
      if (state.failNext) {
        return new Response("boom", { status: 500 });
      }
      let parsed: { email?: string };
      try {
        parsed = JSON.parse(body) as { email?: string };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const groups = (parsed.email && state.table.get(parsed.email)) || [];
      return new Response(JSON.stringify({ groups: groups.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    server,
    port: server.port as number,
    hits,
    get table() {
      return state.table;
    },
    get failNext() {
      return state.failNext;
    },
    set failNext(v: boolean) {
      state.failNext = v;
    },
  };
}

let upstream: MockUpstream;
let groups: MockGroups;
let proxy: ProxyHandle;

beforeEach(() => {
  upstream = startMockUpstream();
  groups = startMockGroups();
});

afterEach(async () => {
  await proxy?.stop();
  upstream.server.stop(true);
  groups.server.stop(true);
});

function startProxyWithAuthz(identity: { source: "header" | "env"; name: string }): ProxyHandle {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "off", // disable lint to focus on authz
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    middlewares: ["authz"],
    middlewareCliOptions: {
      authzEnforce: "error",
      authzOnError: "deny",
      authzIdentitySource: identity.source,
      authzIdentityName: identity.name,
      authzIdentityDecode: "raw",
      authzGroupsUrl: `http://127.0.0.1:${groups.port}/groups`,
      authzGroupsMethod: "POST",
      authzGroupsHeaders: '{"content-type":"application/json"}',
      authzGroupsBody: '{"email": ${json:identity}}',
      authzGroupsExtract: "$.groups[*].id",
      authzWorkflowExtract: "$.tags[*].name",
      authzWorkflowStripPrefix: "owner:",
      authzGroupsCacheTtlMs: "0",
      authzGroupsTimeoutMs: "2000",
    },
  });
  return proxy;
}

function workflowBody(name: string, owners: string[]): string {
  return JSON.stringify({
    name,
    active: false,
    nodes: [],
    connections: {},
    tags: owners.map((id) => ({ name: `owner:${id}` })),
  });
}

function url(path: string): string {
  return `http://127.0.0.1:${proxy.port}${path}`;
}

describe("proxy + authz: header identity", () => {
  test("identity in allowed groups → 200 forwarded to upstream", async () => {
    groups.table.set("ryo@example.com", ["eng", "ops"]);
    startProxyWithAuthz({ source: "header", name: "X-User-Email" });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
      body: workflowBody("wf", ["eng"]),
    });

    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(groups.hits).toHaveLength(1);
  });

  test("identity not in allowed groups → 403, upstream NOT called", async () => {
    groups.table.set("ryo@example.com", ["ops"]);
    startProxyWithAuthz({ source: "header", name: "X-User-Email" });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
      body: workflowBody("wf", ["eng"]),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; middleware: string };
    expect(body.error).toBe("workflow_authz_denied");
    expect(body.middleware).toBe("authz");
    expect(upstream.captured).toHaveLength(0);
  });

  test("workflow without an owner tag → 403", async () => {
    groups.table.set("ryo@example.com", ["eng"]);
    startProxyWithAuthz({ source: "header", name: "X-User-Email" });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
      body: workflowBody("wf", []),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { violations: { rule: string }[] };
    expect(body.violations[0]?.rule).toBe("authz-no-acl");
    expect(upstream.captured).toHaveLength(0);
  });

  test("missing identity header → 403 missing-identity", async () => {
    groups.table.set("ryo@example.com", ["eng"]);
    startProxyWithAuthz({ source: "header", name: "X-User-Email" });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: workflowBody("wf", ["eng"]),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { violations: { rule: string }[] };
    expect(body.violations[0]?.rule).toBe("authz-missing-identity");
    expect(upstream.captured).toHaveLength(0);
  });

  test("groups API failure + onError=deny (default) → 403", async () => {
    groups.failNext = true;
    startProxyWithAuthz({ source: "header", name: "X-User-Email" });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
      body: workflowBody("wf", ["eng"]),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { violations: { rule: string }[] };
    expect(body.violations[0]?.rule).toBe("authz-resolver-error");
    expect(upstream.captured).toHaveLength(0);
  });
});

describe("proxy + authz: PUT update is also gated", () => {
  test("identity must overlap with owner tags on PUT", async () => {
    groups.table.set("ryo@example.com", ["ops"]);
    startProxyWithAuthz({ source: "header", name: "X-User-Email" });

    const res = await fetch(url("/api/v1/workflows/wf-existing"), {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
      body: workflowBody("wf-existing", ["eng"]),
    });
    expect(res.status).toBe(403);
    expect(upstream.captured).toHaveLength(0);
  });
});

describe("proxy + authz: chained with lint", () => {
  test("lint blocks first (422), authz never queried", async () => {
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "error",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      middlewares: ["lint", "authz"],
      middlewareCliOptions: {
        authzEnforce: "error",
        authzIdentitySource: "header",
        authzIdentityName: "X-User-Email",
        authzGroupsUrl: `http://127.0.0.1:${groups.port}/groups`,
        authzGroupsBody: '{"email": ${json:identity}}',
        authzGroupsExtract: "$.groups[*].id",
        authzWorkflowExtract: "$.tags[*].name",
        authzWorkflowStripPrefix: "owner:",
        authzGroupsCacheTtlMs: "0",
      },
    });

    // Missing `name` triggers required-fields lint error.
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
      body: JSON.stringify({ active: false, nodes: [], connections: {}, tags: [] }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workflow_lint_failed");
    expect(groups.hits).toHaveLength(0);
  });
});

describe("proxy + authz: N8N_MIDDLEWARES env var", () => {
  test("env var enables authz when --middleware is not passed", async () => {
    const prev = process.env.N8N_MIDDLEWARES;
    process.env.N8N_MIDDLEWARES = "authz";
    try {
      groups.table.set("ryo@example.com", []);
      // No middlewares: [] config — would default to ["lint"] before the fix.
      proxy = startProxy({
        listen: "127.0.0.1:0",
        upstream: `http://127.0.0.1:${upstream.port}`,
        enforce: "off",
        disableRules: [],
        logFormat: "json",
        allowDuplicates: true,
        middlewares: [],
        middlewareCliOptions: {
          authzEnforce: "error",
          authzIdentitySource: "header",
          authzIdentityName: "X-User-Email",
          authzGroupsUrl: `http://127.0.0.1:${groups.port}/groups`,
          authzGroupsBody: '{"email": ${json:identity}}',
          authzGroupsExtract: "$.groups[*].id",
          authzWorkflowExtract: "$.tags[*].name",
          authzWorkflowStripPrefix: "owner:",
          authzGroupsCacheTtlMs: "0",
        },
      });

      const res = await fetch(url("/api/v1/workflows"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-email": "ryo@example.com" },
        body: workflowBody("wf", ["eng"]),
      });
      expect(res.status).toBe(403);
      expect(upstream.captured).toHaveLength(0);
      expect(groups.hits.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.N8N_MIDDLEWARES;
      else process.env.N8N_MIDDLEWARES = prev;
    }
  });
});
