import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerFactory } from "@/middleware/registry.ts";
import type { ServerMiddleware, ServerMiddlewareFactory } from "@/middleware/types.ts";
import type { McpPolicy } from "@/proxy/mcp/policy.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * Structured request logging, end to end.
 *
 * The proxy emits one terminal line per request plus optional supplementary
 * `policy` lines (MCP listing narrowing), all sharing a requestId that is also
 * echoed to the client on `x-n8n-cli-request-id`. Identity fields appear only
 * under the `logIdentity` opt-in.
 */

interface Captured {
  method: string;
  pathname: string;
  body: string;
}

interface LogEntryJson {
  ts: string;
  logger: string;
  level: string;
  event?: string;
  action: string;
  method?: string;
  path?: string;
  requestId?: string;
  surface?: string;
  operation?: string;
  workflowId?: string;
  workflowName?: string;
  tool?: string;
  rpc?: string;
  status?: number;
  upstreamMs?: number;
  violations?: Array<{ rule: string; severity: string }>;
  identity?: string;
  identitySource?: string;
  identityVerified?: boolean;
  message?: string;
}

const MCP_TOOLS = [
  { name: "search_workflows", description: "Find workflows" },
  { name: "execute_workflow", description: "Run a workflow" },
  { name: "archive_workflow", description: "Archive a workflow" },
];

function startMockUpstream() {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      captured.push({ method: req.method, pathname: url.pathname, body });

      if (req.method === "POST" && url.pathname === "/mcp-server/http") {
        const request = JSON.parse(body) as { id: number; method: string };
        if (request.method === "tools/list") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: MCP_TOOLS } }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { content: [{ type: "text", text: "ok" }] },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port as number, captured };
}

const CLEAN_WORKFLOW = JSON.stringify({
  name: "Clean WF",
  active: false,
  nodes: [],
  connections: {},
});
const VIOLATING_WORKFLOW = JSON.stringify({ active: true, nodes: [], connections: {} });

function mcpPolicy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return { allowTools: [], denyTools: [], workflowTags: [], ...overrides };
}

/**
 * Stands in for oauth-verify / impersonator-verify: writes a verified identity
 * onto the pipeline context so the logging path can pick it up.
 */
function identityStubFactory(): ServerMiddlewareFactory<object> {
  return {
    name: "identity-stub",
    loadFromEnv: () => ({}),
    loadFromCLI: () => ({}),
    build: (): ServerMiddleware => ({
      name: "identity-stub",
      evaluate(ctx) {
        const email = ctx.request?.headers.get("x-verified-email");
        if (email) {
          ctx.identity = email;
          ctx.auth = { effective: { email, layer: "impersonator" } };
        }
        return { block: false, violations: [] };
      },
    }),
  };
}

let upstream: ReturnType<typeof startMockUpstream>;
let proxy: ProxyHandle;
let lines: string[];

function start(extra: Partial<Parameters<typeof startProxy>[0]> = {}): ProxyHandle {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "error",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    logWriter: (line) => lines.push(line),
    ...extra,
  });
  return proxy;
}

function url(p: string): string {
  return `http://127.0.0.1:${proxy.port}${p}`;
}

function logs(): LogEntryJson[] {
  return lines.map((l) => JSON.parse(l) as LogEntryJson);
}

function headerId(res: Response): string | undefined {
  return res.headers.get("x-n8n-cli-request-id") ?? undefined;
}

beforeEach(() => {
  upstream = startMockUpstream();
  lines = [];
});

afterEach(async () => {
  await proxy?.stop();
  upstream.server.stop(true);
});

describe("proxy structured logging: REST mutation", () => {
  test("a clean create logs pass with operation/surface and a matching requestId header", async () => {
    start();
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: CLEAN_WORKFLOW,
    });
    expect(res.status).toBe(200);

    const requestId = headerId(res);
    expect(requestId).toBeTruthy();
    const entry = logs().find((l) => l.action === "pass");
    expect(entry?.logger).toBe("n8n-cli-proxy");
    expect(entry?.level).toBe("info");
    expect(entry?.event).toBe("request");
    expect(entry?.surface).toBe("rest-write");
    expect(entry?.operation).toBe("create");
    expect(entry?.requestId).toBe(requestId);
    expect(entry?.path).toBe("/api/v1/workflows");
  });

  test("a lint block logs error with violations and still carries the requestId header", async () => {
    start();
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VIOLATING_WORKFLOW,
    });
    expect(res.status).toBe(422);

    const entry = logs().find((l) => l.action === "block");
    expect(entry?.level).toBe("error");
    expect(entry?.surface).toBe("rest-write");
    expect(entry?.operation).toBe("create");
    expect(entry?.violations?.length).toBeGreaterThan(0);
    expect(headerId(res)).toBe(entry?.requestId);
  });

  test("warn-mode forward logs level=warn with violations", async () => {
    start({ enforce: "warn" });
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VIOLATING_WORKFLOW,
    });
    expect(res.status).toBe(200);

    const entry = logs().find((l) => l.action === "warn");
    expect(entry?.level).toBe("warn");
    expect(entry?.operation).toBe("create");
    expect(entry?.violations?.length).toBeGreaterThan(0);
  });
});

describe("proxy structured logging: transparent paths", () => {
  test("a list GET logs surface=transparent without an operation", async () => {
    start();
    const res = await fetch(url("/api/v1/workflows"), { headers: { "x-n8n-api-key": "k" } });
    expect(res.status).toBe(200);

    const entry = logs().find((l) => l.action === "forward");
    expect(entry?.surface).toBe("transparent");
    expect(entry?.operation).toBeUndefined();
    expect(entry?.requestId).toBe(headerId(res));
  });

  test("a single-workflow read logs surface=rest-read with workflowId", async () => {
    start();
    await fetch(url("/api/v1/workflows/wf-1"), { headers: { "x-n8n-api-key": "k" } });

    const entry = logs().find((l) => l.action === "forward");
    expect(entry?.surface).toBe("rest-read");
    expect(entry?.operation).toBe("read");
    expect(entry?.workflowId).toBe("wf-1");
  });

  test("probes are not logged", async () => {
    start();
    await fetch(url("/healthz"));
    await fetch(url("/livez"));
    await fetch(url("/readyz"));
    expect(logs()).toHaveLength(0);
  });
});

describe("proxy structured logging: identity (opt-in)", () => {
  test("identity is resolved from a verified middleware and excluded by default", async () => {
    registerFactory(identityStubFactory());
    // Default: logIdentity off -> no identity fields even though verified.
    start({ middlewares: ["identity-stub"] });
    await fetch(url("/api/v1/workflows/wf-1"), {
      headers: { "x-n8n-api-key": "k", "x-verified-email": "user@example.com" },
    });
    expect(logs()[0]?.identity).toBeUndefined();
    await proxy.stop();

    // Opt-in: verified impersonator identity is attached.
    lines = [];
    start({
      logIdentity: true,
      middlewares: ["identity-stub"],
    });
    await fetch(url("/api/v1/workflows/wf-1"), {
      headers: { "x-n8n-api-key": "k", "x-verified-email": "user@example.com" },
    });
    const entry = logs()[0];
    expect(entry?.identity).toBe("user@example.com");
    expect(entry?.identitySource).toBe("impersonator-verify");
    expect(entry?.identityVerified).toBe(true);
  });

  test("the ambient IAP header is used when logIdentity is on and no verified identity exists", async () => {
    start({ logIdentity: true });
    await fetch(url("/api/v1/workflows"), {
      headers: {
        "x-n8n-api-key": "k",
        "x-goog-authenticated-user-email": "accounts.google.com:user@example.com",
      },
    });
    const entry = logs()[0];
    expect(entry?.identity).toBe("user@example.com");
    expect(entry?.identitySource).toBe("iap-header");
    expect(entry?.identityVerified).toBe(false);
  });

  test("identity is never logged when the opt-in is off, even from the IAP header", async () => {
    start();
    await fetch(url("/api/v1/workflows"), {
      headers: {
        "x-n8n-api-key": "k",
        "x-goog-authenticated-user-email": "accounts.google.com:user@example.com",
      },
    });
    expect(logs()[0]?.identity).toBeUndefined();
  });
});

describe("proxy structured logging: MCP gate", () => {
  async function call(params: unknown): Promise<Response> {
    return fetch(url("/mcp-server/http"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
    });
  }

  test("a refused tool call logs tool/rpc/surface and a matching requestId", async () => {
    start({
      mcp: {
        enforce: "error",
        policy: mcpPolicy({ denyTools: ["archive_workflow"] }),
        cacheTtlMs: 60_000,
      },
    });
    const res = await call({ name: "archive_workflow", arguments: {} });
    expect(res.status).toBe(200);

    const entry = logs().find((l) => l.action === "block");
    expect(entry?.surface).toBe("mcp");
    expect(entry?.tool).toBe("archive_workflow");
    expect(entry?.rpc).toBe("tools/call");
    expect(entry?.level).toBe("error");
    expect(entry?.requestId).toBe(headerId(res));
  });

  test("a forwarded tools/list that is narrowed emits a request line plus a policy line sharing requestId", async () => {
    start({
      mcp: {
        enforce: "error",
        policy: mcpPolicy({ denyTools: ["archive_workflow"] }),
        cacheTtlMs: 60_000,
      },
    });
    const res = await fetch(url("/mcp-server/http"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.captured.some((c) => c.body.includes("tools/list"))).toBe(true);

    const requestId = headerId(res);
    const request = logs().find((l) => l.event === "request" && l.action === "forward");
    const policy = logs().find((l) => l.event === "policy");
    expect(request?.surface).toBe("mcp");
    expect(request?.requestId).toBe(requestId);
    expect(policy?.requestId).toBe(requestId);
    expect(policy?.message).toContain("withheld 1 tool(s)");
  });
});
