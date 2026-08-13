import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EnforceLevel } from "@/proxy/config.ts";
import type { McpPolicy } from "@/proxy/mcp/policy.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * The MCP gate, end to end.
 *
 * What matters here is that hiding a tool and refusing it are the same
 * decision: n8n's MCP server publishes one fixed tool set to every client and
 * lists every workflow the connecting user can see, so a filter that only
 * edited `tools/list` would leave an agent free to call whatever it guessed.
 */

interface Captured {
  pathname: string;
  method: string;
  body: string;
}

const TOOLS = [
  { name: "search_workflows", description: "Find workflows" },
  { name: "execute_workflow", description: "Run a workflow" },
  { name: "get_workflow_details", description: "Read a workflow" },
  { name: "archive_workflow", description: "Archive a workflow" },
  { name: "list_credentials", description: "List credentials" },
];

/** A trigger node as n8n stores it. */
const trigger = (name: string, type: string, path?: string, disabled = false) => ({
  id: `n-${name}`,
  name,
  type,
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: path === undefined ? {} : { path },
  ...(disabled ? { disabled: true } : {}),
});

const WEBHOOK = "n8n-nodes-base.webhook";
const FORM = "n8n-nodes-base.formTrigger";
const SCHEDULE = "n8n-nodes-base.scheduleTrigger";

const WORKFLOWS = [
  {
    id: "wf-open",
    name: "[mcp] hospital lookup",
    active: true,
    // The shape the convention asks for: the agent-facing entry first, the
    // repository's test entry after it.
    nodes: [
      trigger("[MCP] entry", FORM, "__mcp__/hospital-lookup"),
      trigger("[CLI Test] entry", WEBHOOK, "__cli-test__/uuid-1"),
    ],
    connections: {},
    settings: { availableInMCP: true },
    tags: [{ id: "1", name: "mcp" }],
  },
  {
    id: "wf-internal",
    name: "payroll export",
    active: true,
    nodes: [trigger("[CLI Test] entry", WEBHOOK, "__cli-test__/uuid-2")],
    connections: {},
    settings: {},
    tags: [{ id: "2", name: "finance" }],
  },
  {
    id: "wf-tagged-only",
    name: "[mcp] draft tool",
    active: true,
    // Tagged, but its only entry is the test hook — no agent-facing path.
    nodes: [trigger("[CLI Test] entry", WEBHOOK, "__cli-test__/uuid-3")],
    connections: {},
    settings: {},
    tags: [{ id: "1", name: "mcp" }],
  },
  {
    id: "wf-cron",
    name: "[mcp] nightly digest",
    active: true,
    // Tagged and MCP-enabled, but a Schedule trigger carries no path at all.
    nodes: [trigger("Every night", SCHEDULE)],
    connections: {},
    settings: { availableInMCP: true },
    tags: [{ id: "1", name: "mcp" }],
  },
];

/** Mock n8n: the MCP endpoint plus enough of the public API to build an index. */
function startMockUpstream(
  options: { sse?: boolean; listFails?: boolean; inflatedCount?: number } = {},
): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.text();
      captured.push({ pathname: url.pathname, method: req.method, body });

      if (url.pathname === "/api/v1/workflows") {
        if (options.listFails) return new Response("nope", { status: 503 });
        return Response.json({ data: WORKFLOWS, nextCursor: null });
      }

      let request: { id?: unknown; method?: string; params?: { name?: string } } = {};
      try {
        if (body) request = JSON.parse(body);
      } catch {
        // n8n would answer a malformed body on its own terms; here it is enough
        // that the proxy handed it over unchanged.
        return new Response("bad request", { status: 400 });
      }
      const reply = mcpReply(request, options.inflatedCount);
      if (options.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(reply);
    },
  });
  return { server, port: server.port!, captured };
}

function mcpReply(
  request: { id?: unknown; method?: string; params?: { name?: string } },
  inflatedCount?: number,
): unknown {
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } };
  }
  if (request.params?.name === "search_workflows") {
    // The shape a live 2.32.5 instance returns: the same {data, count} payload
    // twice, once structured and once JSON-encoded in a text block.
    const payload = {
      data: WORKFLOWS.map((w) => ({
        id: w.id,
        name: w.name,
        description: `what ${w.name} does`,
        availableInMCP: (w.settings as { availableInMCP?: boolean }).availableInMCP === true,
        tags: w.tags,
      })),
      // n8n reports the total number of matches, which on a real instance is
      // far larger than the page it just sent.
      count: inflatedCount ?? WORKFLOWS.length,
    };
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: { content: [{ type: "text", text: `ran ${request.params?.name}` }] },
  };
}

function policy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return { allowTools: [], denyTools: [], workflowTags: [], ...overrides };
}

let upstream: ReturnType<typeof startMockUpstream>;
let proxy: ProxyHandle;

function start(mcpPolicy: McpPolicy, enforce: EnforceLevel = "error"): void {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    mcp: { enforce, policy: mcpPolicy, cacheTtlMs: 60_000 },
  });
}

async function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.includes("data: ") ? text.split("data: ")[1]!.split("\n")[0]! : text;
  return JSON.parse(data) as Record<string, unknown>;
}

function toolNames(reply: Record<string, unknown>): string[] {
  const result = reply.result as { tools?: Array<{ name: string }> };
  return (result.tools ?? []).map((t) => t.name);
}

beforeEach(() => {
  upstream = startMockUpstream();
});

afterEach(async () => {
  await proxy?.stop();
  await upstream.server.stop(true);
});

describe("MCP gate: tools/list", () => {
  test("withholds everything outside the allowlist", async () => {
    start(policy({ allowTools: ["search_workflows", "get_workflow_details"] }));
    expect(toolNames(await call("tools/list"))).toEqual([
      "search_workflows",
      "get_workflow_details",
    ]);
  });

  test("a deny glob removes a family of tools", async () => {
    start(policy({ denyTools: ["*credential*", "archive_*"] }));
    expect(toolNames(await call("tools/list"))).toEqual([
      "search_workflows",
      "execute_workflow",
      "get_workflow_details",
    ]);
  });

  test("a policy that withholds nothing leaves the reply untouched", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    expect(toolNames(await call("tools/list"))).toHaveLength(TOOLS.length);
  });

  test("filtering works over SSE framing too", async () => {
    await upstream.server.stop(true);
    upstream = startMockUpstream({ sse: true });
    start(policy({ allowTools: ["search_workflows"] }));
    expect(toolNames(await call("tools/list"))).toEqual(["search_workflows"]);
  });
});

describe("MCP gate: tools/call", () => {
  test("a withheld tool is refused here, not forwarded", async () => {
    start(policy({ denyTools: ["archive_workflow"] }));
    const reply = await call("tools/call", { name: "archive_workflow", arguments: {} });

    expect((reply.error as { message: string }).message).toContain("Unknown tool");
    expect(upstream.captured.some((c) => c.body.includes("archive_workflow"))).toBe(false);
  });

  test("an allowed tool reaches upstream", async () => {
    start(policy({ allowTools: ["search_workflows"] }));
    const reply = await call("tools/call", { name: "search_workflows", arguments: {} });
    expect(reply.result).toBeDefined();
    expect(upstream.captured.some((c) => c.pathname === "/mcp-server/http")).toBe(true);
  });
});

describe("MCP gate: workflow scope", () => {
  test("a workflow outside the tag scope is refused", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: "wf-internal" },
    });

    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("wf-internal");
    expect(upstream.captured.some((c) => c.body.includes("wf-internal"))).toBe(false);
  });

  test("a workflow inside the scope goes through", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: "wf-open" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("the tag alone decides — availableInMCP is n8n's own check, not ours", async () => {
    // `wf-tagged-only` carries the tag but not the setting. n8n refuses it on
    // its own, so re-checking here would buy nothing and cost a flag.
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: "wf-tagged-only" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("a tool that names no workflow is refused", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", { name: "execute_workflow", arguments: {} });
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
  });

  test("a tool that targets no workflow passes untouched", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", { name: "search_workflows", arguments: {} });
    expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("an unknown tool carrying a forbidden id is still caught", async () => {
    // The backstop. The built-in tool→argument table was read off n8n's docs,
    // not off the running server, so the gate must not depend on having
    // guessed the tool name or the parameter name right.
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "some_tool_this_release_never_heard_of",
      arguments: { target: { ref: "wf-internal" } },
    });
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("wf-internal");
    expect(upstream.captured.some((c) => c.body.includes("wf-internal"))).toBe(false);
  });

  test("a known tool whose argument was renamed upstream is still caught", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflow_id: "wf-internal" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
  });

  test("an argument that merely looks like text is not mistaken for an id", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "search_workflows",
      arguments: { query: "wf-internal-ish notes" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("the id may arrive as a number", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: 42 },
    });
    // 42 is no workflow of this instance, but it was recognised as a target
    // rather than treated as "no workflow named" — and refused either way.
    const result = reply.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toContain("42");
  });

  test("the id may arrive as a number", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: 42 },
    });
    // 42 is not in the allowlist, but it was recognised as a target rather than
    // treated as "no workflow named".
    const result = reply.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toContain("42");
  });
});

describe("MCP gate: failure and enforcement modes", () => {
  test("an unreadable workflow list refuses the call", async () => {
    // Fail closed: a gate that opens during an upstream outage is not a gate,
    // and an operator who wants the calls through has `--mcp-enforce warn`.
    await upstream.server.stop(true);
    upstream = startMockUpstream({ listFails: true });
    start(policy({ workflowTags: ["mcp"] }));

    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: "wf-open" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBe(true);
  });

  test("warn mode forwards even when the list is unreadable", async () => {
    await upstream.server.stop(true);
    upstream = startMockUpstream({ listFails: true });
    start(policy({ workflowTags: ["mcp"] }), "warn");

    const reply = await call("tools/call", {
      name: "execute_workflow",
      arguments: { workflowId: "wf-open" },
    });
    expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("warn mode forwards a call the policy would refuse", async () => {
    start(policy({ denyTools: ["archive_workflow"] }), "warn");
    const reply = await call("tools/call", { name: "archive_workflow", arguments: {} });
    expect(reply.error).toBeUndefined();
    expect(upstream.captured.some((c) => c.body.includes("archive_workflow"))).toBe(true);
  });

  test("warn mode still forwards the unfiltered tool list", async () => {
    start(policy({ allowTools: ["search_workflows"] }), "warn");
    // Warn is about learning what a policy would break; a client that never
    // sees the tool cannot exercise it, and the log would stay empty.
    expect(toolNames(await call("tools/list"))).toHaveLength(TOOLS.length);
  });

  test("off mode is a plain forward", async () => {
    start(policy({ allowTools: ["search_workflows"] }), "off");
    expect(toolNames(await call("tools/list"))).toHaveLength(TOOLS.length);
  });
});

describe("MCP gate: entry-trigger path scope", () => {
  const ENTRY = { entryPathPattern: "__mcp__/*" };

  async function execute(workflowId: string): Promise<Record<string, unknown>> {
    return await call("tools/call", { name: "execute_workflow", arguments: { workflowId } });
  }

  function refusal(reply: Record<string, unknown>): string | null {
    const result = reply.result as { isError?: boolean; content?: Array<{ text: string }> };
    return result?.isError ? (result.content?.[0]?.text ?? "") : null;
  }

  test("a workflow whose entry declares the agent-facing path is reachable", async () => {
    start(policy(ENTRY));
    expect(refusal(await execute("wf-open"))).toBeNull();
  });

  test("a workflow whose only entry is the repository's test hook is not", async () => {
    // The point of the path rule: `[CLI Test]` is a real, working webhook, so
    // trigger *type* cannot tell it apart from an agent-facing one. The path can.
    start(policy(ENTRY));
    expect(refusal(await execute("wf-tagged-only"))).toContain(
      "outside the agent-facing namespace",
    );
  });

  test("a Schedule-only workflow falls out without being special-cased", async () => {
    // Schedule triggers carry no path at all, so a cron job cannot opt itself
    // in by accident — an agent firing a nightly batch on demand is exactly the
    // surprise this avoids.
    start(policy(ENTRY));
    expect(refusal(await execute("wf-cron"))).toContain("declares no path");
  });

  test("the entry is the FIRST supported trigger, mirroring n8n", async () => {
    // wf-open lists the agent entry first and the test hook second. Were the
    // gate to scan for *any* matching trigger instead of the first one, the
    // ordering that decides n8n's behaviour would stop mattering here — and the
    // two would disagree.
    start(policy({ entryPathPattern: "__cli-test__/*" }));
    expect(refusal(await execute("wf-open"))).toContain("__mcp__/hospital-lookup");
  });

  test("tags and entry path are both required when both are configured", async () => {
    start(policy({ workflowTags: ["finance"], entryPathPattern: "__mcp__/*" }));
    const text = refusal(await execute("wf-open"));
    expect(text).toContain("finance");
  });

  test("the refusal names the workflow and the reason, not just 'no'", async () => {
    start(policy(ENTRY));
    const text = refusal(await execute("wf-cron"));
    expect(text).toContain("wf-cron");
    expect(text).toContain("Every night");
  });
});

describe("MCP gate: narrowing search_workflows", () => {
  function sentArgs(): Record<string, unknown> | undefined {
    const hit = upstream.captured.find((c) => c.body.includes("search_workflows"));
    if (!hit) return undefined;
    return JSON.parse(hit.body).params?.arguments;
  }

  test("the policy's tags are added to the agent's own filter", async () => {
    // n8n answers search_workflows with everything the token's owner can read.
    // Its `tags` filter is an AND, so merging the policy's tags in can only
    // shrink the result — the one part of the listing surface that can be closed.
    start(policy({ workflowTags: ["mcp"] }));
    await call("tools/call", {
      name: "search_workflows",
      arguments: { query: "hospital", tags: ["ops"] },
    });
    expect(sentArgs()?.tags).toEqual(["ops", "mcp"]);
    expect(sentArgs()?.query).toBe("hospital");
  });

  test("tags are added when the agent asked for none", async () => {
    start(policy({ workflowTags: ["mcp"] }));
    await call("tools/call", { name: "search_workflows", arguments: {} });
    expect(sentArgs()?.tags).toEqual(["mcp"]);
  });

  test("a policy with no tags leaves the call alone", async () => {
    // An entry-path policy has no equivalent argument upstream, so the listing
    // stays wide. Better to leave it visibly untouched than to fake a filter.
    start(policy({ entryPathPattern: "__mcp__/*" }));
    await call("tools/call", { name: "search_workflows", arguments: { query: "x" } });
    expect(sentArgs()).toEqual({ query: "x" });
  });

  test("warn mode does not rewrite the call either", async () => {
    start(policy({ workflowTags: ["mcp"] }), "warn");
    await call("tools/call", { name: "search_workflows", arguments: {} });
    expect(sentArgs()).toEqual({});
  });
});

describe("MCP gate: filtering search_workflows results", () => {
  /** The two channels n8n sends the same payload down, read separately. */
  function listed(reply: Record<string, unknown>): {
    structured: string[];
    text: string[];
    count: number;
  } {
    const result = reply.result as {
      structuredContent?: { data?: Array<{ id: string }>; count?: number };
      content?: Array<{ text?: string }>;
    };
    const text = JSON.parse(result.content?.[0]?.text ?? "{}") as {
      data?: Array<{ id: string }>;
      count?: number;
    };
    return {
      structured: (result.structuredContent?.data ?? []).map((w) => w.id),
      text: (text.data ?? []).map((w) => w.id),
      count: result.structuredContent?.count ?? -1,
    };
  }

  async function search(args: unknown = {}): Promise<Record<string, unknown>> {
    return await call("tools/call", { name: "search_workflows", arguments: args });
  }

  test("an entry-path policy narrows the listing, with no tag involved", async () => {
    // The listing is the half n8n cannot close: its only relevant filter is
    // `tags`, so without this a path-based policy would let an agent read the
    // name and description of every workflow before finding out it may run one.
    start(policy({ entryPathPattern: "__mcp__/*" }));
    expect(listed(await search()).structured).toEqual(["wf-open"]);
  });

  test("both channels are rewritten, and they agree", async () => {
    // Filtering one and not the other would send the names out through the
    // channel that was left alone.
    start(policy({ entryPathPattern: "__mcp__/*" }));
    const seen = listed(await search());
    expect(seen.text).toEqual(seen.structured);
  });

  test("count reports the rows that survived, not the upstream total", async () => {
    // n8n's `count` is the total number of matches, not the size of the page.
    // Against a live instance a page keeping 1 row came back saying 1385 —
    // telling the model to keep paging after rows it will never be shown, and
    // roughly how many workflows are being withheld from it.
    start(policy({ entryPathPattern: "__mcp__/*" }));
    expect(listed(await search()).count).toBe(1);
  });

  test("an upstream total far larger than the page does not leak through", async () => {
    await upstream.server.stop(true);
    upstream = startMockUpstream({ inflatedCount: 1385 });
    start(policy({ entryPathPattern: "__mcp__/*" }));

    const seen = listed(await search());
    expect(seen.structured).toEqual(["wf-open"]);
    expect(seen.count).toBe(1);
  });

  test("a tag policy filters the reply as well as narrowing the request", async () => {
    // The upstream `tags` argument is an optimisation; this is the enforcement.
    // The mock ignores the argument, so what comes back is the unfiltered list.
    start(policy({ workflowTags: ["mcp"] }));
    expect(listed(await search()).structured).toEqual(["wf-open", "wf-tagged-only", "wf-cron"]);
  });

  test("filtering survives SSE framing", async () => {
    await upstream.server.stop(true);
    upstream = startMockUpstream({ sse: true });
    start(policy({ entryPathPattern: "__mcp__/*" }));
    expect(listed(await search()).structured).toEqual(["wf-open"]);
  });

  test("a page where everything is out of scope comes back empty, not refilled", async () => {
    start(policy({ entryPathPattern: "__nothing__/*" }));
    const seen = listed(await search());
    expect(seen.structured).toEqual([]);
    expect(seen.count).toBe(0);
  });

  test("a tools-only policy leaves the listing alone", async () => {
    // Nothing has been said about which workflows are reachable, so filtering
    // the reply would be inventing a policy the operator did not write.
    start(policy({ allowTools: ["search_workflows"] }));
    expect(listed(await search()).structured).toHaveLength(WORKFLOWS.length);
  });

  test("warn mode returns the listing untouched", async () => {
    start(policy({ entryPathPattern: "__mcp__/*" }), "warn");
    expect(listed(await search()).structured).toHaveLength(WORKFLOWS.length);
  });

  test("another tool's reply is not filtered by resemblance", async () => {
    // `{data, count}` is a shared envelope. The reply to filter is identified
    // by the id it answers, not by looking like a search result.
    start(policy({ entryPathPattern: "__mcp__/*" }));
    const reply = await call("tools/call", { name: "search_projects", arguments: {} });
    const result = reply.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("ran search_projects");
  });

  test("an unreadable workflow list withholds the listing rather than passing it", async () => {
    await upstream.server.stop(true);
    upstream = startMockUpstream({ listFails: true });
    start(policy({ entryPathPattern: "__mcp__/*" }));

    const reply = await search();
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("could not verify");
  });
});

describe("MCP gate: startup", () => {
  async function readyz(): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/readyz`);
    return { status: res.status, body: await res.text() };
  }

  async function waitForReady(): Promise<{ status: number; body: string }> {
    for (let i = 0; i < 50; i++) {
      const r = await readyz();
      if (r.body !== "preparing\n") return r;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return readyz();
  }

  function listCalls(): number {
    return upstream.captured.filter((c) => c.pathname === "/api/v1/workflows").length;
  }

  /**
   * The prefetch is deliberately outside the readiness pass, so `/readyz`
   * turning green says nothing about it having run. Poll for the effect.
   */
  async function waitForPrefetch(): Promise<void> {
    for (let i = 0; i < 100 && listCalls() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("the workflow index is fetched at startup, not inside the first call", async () => {
    // On Cloud Run with min-scale 0 this is the difference between a cold
    // start costing the container's own startup and costing the caller's
    // request timeout — which the gate would answer by failing closed.
    start(policy({ workflowTags: ["mcp"] }));
    await waitForPrefetch();

    expect(listCalls()).toBe(1);

    await call("tools/call", { name: "execute_workflow", arguments: { workflowId: "wf-open" } });
    expect(listCalls()).toBe(1);
  });

  test("a call racing the prefetch joins it instead of starting a second one", async () => {
    // Without single-flight the prefetch and the first request would each walk
    // the whole workflow list, doubling the cost exactly when it is highest.
    start(policy({ workflowTags: ["mcp"] }));

    const replies = await Promise.all([
      call("tools/call", { name: "execute_workflow", arguments: { workflowId: "wf-open" } }),
      call("tools/call", { name: "execute_workflow", arguments: { workflowId: "wf-open" } }),
    ]);

    for (const reply of replies) {
      expect((reply.result as { isError?: boolean }).isError).toBeUndefined();
    }
    expect(listCalls()).toBe(1);
  });

  test("readiness does not wait on the prefetch", async () => {
    // A deployment whose startup probe reads /readyz must not be held back by
    // a slow (or down) n8n: that turns a blip into a revision that never
    // starts, which is worse than the cold-start latency being avoided.
    await upstream.server.stop(true);
    upstream = startMockUpstream({ listFails: true });
    start(policy({ workflowTags: ["mcp"] }));

    expect((await waitForReady()).status).toBe(200);
  });

  test("enforce=off does not paginate the whole instance for nothing", async () => {
    // A gate someone turned off should not walk every page of
    // /api/v1/workflows at startup, nor log a credential failure for a lookup
    // no request will read.
    start(policy({ workflowTags: ["mcp"] }), "off");
    await waitForReady();
    await call("tools/list");
    expect(listCalls()).toBe(0);
  });

  test("no workflow scope means no prefetch at all", async () => {
    // Nothing to resolve, so the listing is never issued — the gate does not
    // pay for an index it would not read. Safe to assert without polling:
    // with no scope the lookup returns before it can make a request.
    start(policy({ allowTools: ["search_workflows"] }));
    await waitForReady();
    await call("tools/call", { name: "search_workflows", arguments: {} });
    expect(listCalls()).toBe(0);
  });
});

describe("MCP gate: what it leaves alone", () => {
  test("initialize passes through", async () => {
    start(policy({ allowTools: ["search_workflows"], workflowTags: ["mcp"] }));
    const reply = await call("initialize", {});
    expect(reply.result).toBeDefined();
  });

  test("a GET on the MCP path (the server-to-client stream) is forwarded", async () => {
    start(policy({ allowTools: ["search_workflows"] }));
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`);
    expect(res.status).toBe(200);
    expect(upstream.captured.some((c) => c.method === "GET")).toBe(true);
  });

  test("a non-JSON-RPC body is handed to n8n unchanged", async () => {
    start(policy({ allowTools: ["search_workflows"] }));
    await fetch(`http://127.0.0.1:${proxy.port}/mcp-server/http`, {
      method: "POST",
      body: "not json",
    });
    expect(upstream.captured.some((c) => c.body === "not json")).toBe(true);
  });

  test("the REST API path is untouched by the gate", async () => {
    start(policy({ denyTools: ["*"] }));
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`);
    expect(res.status).toBe(200);
  });
});
