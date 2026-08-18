import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerFactory } from "@/middleware/registry.ts";
import type { ServerMiddleware, ServerMiddlewareFactory } from "@/middleware/types.ts";
import { matchWorkflowRead } from "@/proxy/rest/read-router.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

interface CapturedRequest {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: CapturedRequest[];
}

function startMockUpstream(handlers: {
  members?: Array<{ email: string; role: string }>;
  instanceUsers?: Array<{ email: string; role: string }>;
  workflows?: Record<string, unknown>;
}): MockUpstream {
  const captured: CapturedRequest[] = [];
  const members = handlers.members ?? [];
  const instanceUsers = handlers.instanceUsers ?? [];
  const workflows = handlers.workflows ?? {};

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

      if (url.pathname.includes("/projects/") && url.pathname.endsWith("/users")) {
        return Response.json({
          data: members.map((m, i) => ({ id: `u${i}`, email: m.email, role: m.role })),
        });
      }
      if (url.pathname === "/api/v1/users") {
        return Response.json({
          data: instanceUsers.map((u, i) => ({ id: `iu${i}`, email: u.email, role: u.role })),
        });
      }
      const wfMatch = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
      if (wfMatch?.[1]) {
        const wf = workflows[decodeURIComponent(wfMatch[1])];
        if (wf) return Response.json(wf);
        return new Response("not found", { status: 404 });
      }
      if (req.method === "PUT" && url.pathname.startsWith("/api/v1/workflows/")) {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  });

  return { server, port: server.port as number, captured };
}

const STORED_WORKFLOW = {
  id: "wf1",
  name: "Demo",
  active: false,
  nodes: [],
  connections: {},
  shared: [{ role: "workflow:owner", projectId: "proj-1" }],
};

let proxy: ProxyHandle;
let upstream: MockUpstream;

beforeEach(() => {
  upstream = startMockUpstream({
    members: [{ email: "viewer@example.com", role: "project:viewer" }],
    workflows: { wf1: STORED_WORKFLOW },
  });
});

afterEach(async () => {
  await proxy?.stop();
  upstream.server.stop(true);
});

function startProxyWithProjectRole(): ProxyHandle {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    middlewares: ["project-role"],
    middlewareCliOptions: {
      projectRoleEnforce: "error",
      projectRoleIdentitySource: "header",
      projectRoleIdentityName: "x-user-email",
    },
  });
  return proxy;
}

describe("read router", () => {
  test("matches GET /api/v1/workflows/:id", () => {
    expect(matchWorkflowRead("GET", "/api/v1/workflows/wf1")).toEqual({
      action: "read",
      id: "wf1",
    });
    expect(matchWorkflowRead("GET", "/api/v1/workflows")).toBeNull();
  });
});

describe("proxy project-role enforcement", () => {
  test("blocks viewer from PUT /workflows/:id", async () => {
    startProxyWithProjectRole();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-email": "viewer@example.com",
      },
      body: JSON.stringify({ name: "Demo", active: false, nodes: [], connections: {} }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workflow_project_role_denied");
    expect(
      upstream.captured.some((c) => c.method === "PUT" && c.pathname.includes("/workflows/wf1")),
    ).toBe(false);
  });

  test("allows viewer to GET /workflows/:id", async () => {
    startProxyWithProjectRole();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      headers: { "x-user-email": "viewer@example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("blocks non-member from GET /workflows/:id", async () => {
    startProxyWithProjectRole();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      headers: { "x-user-email": "stranger@example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("allows viewer to GET /workflows/:id when only write is in scope", async () => {
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      middlewares: ["project-role"],
      middlewareCliOptions: {
        projectRoleEnforce: "error",
        projectRoleIdentitySource: "header",
        projectRoleIdentityName: "x-user-email",
        projectRoleActions: "update,delete",
      },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      headers: { "x-user-email": "viewer@example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("allows editor to PUT /workflows/:id", async () => {
    upstream.server.stop(true);
    upstream = startMockUpstream({
      members: [{ email: "editor@example.com", role: "project:editor" }],
      workflows: { wf1: STORED_WORKFLOW },
    });
    startProxyWithProjectRole();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-user-email": "editor@example.com",
      },
      body: JSON.stringify({ name: "Demo", active: false, nodes: [], connections: {} }),
    });
    expect(res.status).toBe(200);
    expect(upstream.captured.some((c) => c.method === "PUT")).toBe(true);
  });
});

/**
 * Stands in for oauth-verify / impersonator-verify: writes a verified email
 * onto ctx so a later project-role with identity.source=none can see it.
 * The production bug was GET skipping that chain, so identity stayed empty.
 */
function identityStubFactory(): ServerMiddlewareFactory<object> {
  return {
    name: "identity-stub",
    loadFromEnv: () => ({}),
    loadFromCLI: () => ({}),
    build: (): ServerMiddleware => ({
      name: "identity-stub",
      evaluate(ctx) {
        const email = ctx.request?.headers.get("x-impersonator-email");
        if (email) {
          ctx.identity = email;
          ctx.auth = { effective: { email, layer: "impersonator" } };
        }
        return { block: false, violations: [] };
      },
    }),
  };
}

function startProxyWithVerifiedIdentity(): ProxyHandle {
  registerFactory(identityStubFactory());
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    middlewares: ["identity-stub", "project-role"],
    middlewareCliOptions: {
      projectRoleEnforce: "error",
    },
  });
  return proxy;
}

describe("proxy project-role identity from earlier middleware", () => {
  test("GET succeeds when a prior middleware populated ctx.identity", async () => {
    startProxyWithVerifiedIdentity();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      headers: { "x-impersonator-email": "viewer@example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("GET is denied when identity source is none and nothing populated ctx.identity", async () => {
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${upstream.port}`,
      enforce: "off",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: true,
      middlewares: ["project-role"],
      middlewareCliOptions: {
        projectRoleEnforce: "error",
      },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      violations: Array<{ rule: string }>;
    };
    expect(body.error).toBe("workflow_project_role_denied");
    expect(body.violations[0]?.rule).toBe("project-role-missing-identity");
  });

  test("PUT also sees identity populated by a prior middleware", async () => {
    upstream.server.stop(true);
    upstream = startMockUpstream({
      members: [{ email: "editor@example.com", role: "project:editor" }],
      workflows: { wf1: STORED_WORKFLOW },
    });
    startProxyWithVerifiedIdentity();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-impersonator-email": "editor@example.com",
      },
      body: JSON.stringify({ name: "Demo", active: false, nodes: [], connections: {} }),
    });
    expect(res.status).toBe(200);
  });
});
