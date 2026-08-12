import { describe, expect, test } from "bun:test";
import { parseMcpSettings } from "@/proxy/mcp/config.ts";
import {
  findEntryTrigger,
  globMatch,
  hasWorkflowScope,
  isToolAllowed,
  type McpPolicy,
  scanForWorkflowIds,
  targetWorkflowId,
} from "@/proxy/mcp/policy.ts";

const NO_ENV = {} as NodeJS.ProcessEnv;

function policy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return { allowTools: [], denyTools: [], workflowTags: [], ...overrides };
}

describe("globMatch", () => {
  test("matches literally when there is no wildcard", () => {
    expect(globMatch("execute_workflow", "execute_workflow")).toBe(true);
    expect(globMatch("execute_workflow", "execute_workflow_v2")).toBe(false);
  });

  test("* spans any run of characters", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("*_workflow", "execute_workflow")).toBe(true);
    expect(globMatch("*credential*", "list_credentials")).toBe(true);
    expect(globMatch("search_*", "execute_workflow")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal", () => {
    // Otherwise `.` in a pattern would quietly match any character, and a
    // pattern meant to name one tool would cover several.
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a.b", "a.b")).toBe(true);
  });
});

describe("isToolAllowed", () => {
  test("an empty allowlist allows everything", () => {
    expect(isToolAllowed(policy(), "archive_workflow")).toBe(true);
  });

  test("deny wins over allow", () => {
    const p = policy({ allowTools: ["*_workflow"], denyTools: ["archive_workflow"] });
    expect(isToolAllowed(p, "execute_workflow")).toBe(true);
    expect(isToolAllowed(p, "archive_workflow")).toBe(false);
  });

  test("an allowlist excludes what it does not name", () => {
    expect(isToolAllowed(policy({ allowTools: ["search_workflows"] }), "execute_workflow")).toBe(
      false,
    );
  });
});

describe("targetWorkflowId", () => {
  test("undefined for a tool not known to target a workflow", () => {
    expect(targetWorkflowId("search_workflows", { workflowId: "x" })).toBeUndefined();
  });

  test("both spellings n8n has used are covered", () => {
    // n8n renames these between versions: a live 2.32.5 instance serves
    // `prepare_test_pin_data`, the default branch `prepare_workflow_pin_data`.
    // Picking one left the other unscoped by name on half the fleet.
    expect(targetWorkflowId("prepare_test_pin_data", { workflowId: "wf1" })).toBe("wf1");
    expect(targetWorkflowId("prepare_workflow_pin_data", { workflowId: "wf1" })).toBe("wf1");
    expect(targetWorkflowId("restore_workflow_version", { workflowId: "wf1" })).toBe("wf1");
  });

  test("null when the tool targets one but the call named none", () => {
    expect(targetWorkflowId("execute_workflow", {})).toBeNull();
    expect(targetWorkflowId("execute_workflow", { workflowId: "" })).toBeNull();
  });

  test("falls back to `id`", () => {
    expect(targetWorkflowId("execute_workflow", { id: "wf1" })).toBe("wf1");
  });

  test("a numeric id is still an id", () => {
    expect(targetWorkflowId("execute_workflow", { workflowId: 7 })).toBe("7");
  });
});

describe("scanForWorkflowIds", () => {
  const known = new Set(["wf-a", "wf-b"]);

  test("finds an id under a parameter name nobody predicted", () => {
    // The whole point: the built-in tool→argument table was read off n8n's
    // docs, not off the running server. This check does not depend on it.
    expect([...scanForWorkflowIds({ someFutureParam: "wf-a" }, known)]).toEqual(["wf-a"]);
  });

  test("walks nested objects and arrays", () => {
    const args = { filter: { ids: ["wf-b", "nope"] }, other: { deep: { x: "wf-a" } } };
    expect([...scanForWorkflowIds(args, known)].sort()).toEqual(["wf-a", "wf-b"]);
  });

  test("a numeric value is compared as its string form", () => {
    expect([...scanForWorkflowIds({ id: 42 }, new Set(["42"]))]).toEqual(["42"]);
  });

  test("ignores values that are not workflow ids", () => {
    expect([...scanForWorkflowIds({ q: "wf", note: "wf-a-ish" }, known)]).toEqual([]);
  });

  test("stops descending before a pathological payload can spin the gate", () => {
    let deep: unknown = "wf-a";
    for (let i = 0; i < 40; i++) deep = { deep };
    expect([...scanForWorkflowIds(deep, known)]).toEqual([]);
  });
});

describe("findEntryTrigger", () => {
  const node = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    name,
    type,
    ...extra,
  });

  test("takes the first supported trigger in array order, like n8n does", () => {
    const entry = findEntryTrigger([
      node("Set", "n8n-nodes-base.set"),
      node("A", "n8n-nodes-base.webhook", { parameters: { path: "__mcp__/a" } }),
      node("B", "n8n-nodes-base.formTrigger", { parameters: { path: "__mcp__/b" } }),
    ]);
    expect(entry?.name).toBe("A");
    expect(entry?.path).toBe("__mcp__/a");
  });

  test("skips disabled triggers, like n8n does", () => {
    const entry = findEntryTrigger([
      node("Off", "n8n-nodes-base.webhook", { disabled: true, parameters: { path: "off" } }),
      node("On", "n8n-nodes-base.webhook", { parameters: { path: "on" } }),
    ]);
    expect(entry?.name).toBe("On");
  });

  test("a Schedule trigger is an entry, but carries no path", () => {
    const entry = findEntryTrigger([node("Nightly", "n8n-nodes-base.scheduleTrigger")]);
    expect(entry?.type).toBe("n8n-nodes-base.scheduleTrigger");
    expect(entry?.path).toBeUndefined();
  });

  test("a webhook that never had a path set carries none either", () => {
    // n8n falls back to the node's webhookId for the URL, which is a UUID and
    // deliberately not something a path convention should match.
    const entry = findEntryTrigger([
      node("W", "n8n-nodes-base.webhook", { parameters: {}, webhookId: "uuid" }),
    ]);
    expect(entry?.path).toBeUndefined();
  });

  test("ignores node types n8n will not enter a workflow through", () => {
    expect(
      findEntryTrigger([
        node("Sub", "n8n-nodes-base.executeWorkflowTrigger"),
        node("Manual", "n8n-nodes-base.manualTrigger"),
      ]),
    ).toBeNull();
  });

  test("no nodes at all is not an entry", () => {
    expect(findEntryTrigger([])).toBeNull();
    expect(findEntryTrigger(undefined)).toBeNull();
  });
});

describe("hasWorkflowScope", () => {
  test("false until a tag scopes workflows", () => {
    expect(hasWorkflowScope(policy())).toBe(false);
    expect(hasWorkflowScope(policy({ denyTools: ["*"] }))).toBe(false);
    expect(hasWorkflowScope(policy({ workflowTags: ["mcp"] }))).toBe(true);
    expect(hasWorkflowScope(policy({ entryPathPattern: "__mcp__/*" }))).toBe(true);
  });
});

describe("parseMcpSettings", () => {
  test("no gate, and no complaint, when nothing was configured", () => {
    expect(parseMcpSettings({}, NO_ENV)).toBeNull();
  });

  test("a policy written without an enforce level is refused, not ignored", () => {
    // The dangerous shape: the deployment says "only these tools, only these
    // workflows" and forwards /mcp-server/ unfiltered, with nothing in the
    // startup line to contradict the belief that the gate is on.
    expect(() => parseMcpSettings({ mcpAllowTools: "search_workflows" }, NO_ENV)).toThrow(
      /N8N_MCP_ALLOW_TOOLS.*--mcp-enforce/s,
    );
    expect(() =>
      parseMcpSettings({}, { N8N_MCP_WORKFLOW_TAGS: "mcp" } as NodeJS.ProcessEnv),
    ).toThrow(/N8N_MCP_WORKFLOW_TAGS/);
  });

  test("the cache TTL alone is not a policy, so it does not block startup", () => {
    // It tunes how often a lookup repeats. Someone who set only that has
    // expressed no belief about what is exposed.
    expect(parseMcpSettings({ mcpCacheTtlMs: "5000" }, NO_ENV)).toBeNull();
  });

  test("enforce=off is a real answer, and silences that check", () => {
    const settings = parseMcpSettings({ mcpEnforce: "off", mcpWorkflowTags: "mcp" }, NO_ENV);
    expect(settings?.enforce).toBe("off");
  });

  test("reads the whole policy off the flags", () => {
    const settings = parseMcpSettings(
      {
        mcpEnforce: "error",
        mcpAllowTools: "search_workflows, execute_workflow",
        mcpDenyTools: "*credential*",
        mcpWorkflowTags: "mcp,prod",
        mcpEntryPathPattern: "__mcp__/*",
        mcpCacheTtlMs: "5000",
      },
      NO_ENV,
    );

    expect(settings?.enforce).toBe("error");
    expect(settings?.policy.allowTools).toEqual(["search_workflows", "execute_workflow"]);
    expect(settings?.policy.denyTools).toEqual(["*credential*"]);
    expect(settings?.policy.workflowTags).toEqual(["mcp", "prod"]);
    expect(settings?.policy.entryPathPattern).toBe("__mcp__/*");
    expect(settings?.cacheTtlMs).toBe(5000);
  });

  test("falls back to the environment", () => {
    const settings = parseMcpSettings({}, {
      N8N_MCP_ENFORCE: "warn",
      N8N_MCP_WORKFLOW_TAGS: "mcp",
    } as NodeJS.ProcessEnv);

    expect(settings?.enforce).toBe("warn");
    expect(settings?.policy.workflowTags).toEqual(["mcp"]);
    expect(settings?.cacheTtlMs).toBe(60_000);
  });

  test("an unset entry-path pattern stays absent rather than becoming an empty glob", () => {
    // An empty string would match nothing, silently gating everything off.
    const settings = parseMcpSettings({ mcpEnforce: "error", mcpEntryPathPattern: "  " }, NO_ENV);
    expect(settings?.policy.entryPathPattern).toBeUndefined();
  });

  test("the entry-path pattern also comes from the environment", () => {
    const settings = parseMcpSettings({}, {
      N8N_MCP_ENFORCE: "error",
      N8N_MCP_ENTRY_PATH_PATTERN: "__mcp__/*",
    } as NodeJS.ProcessEnv);
    expect(settings?.policy.entryPathPattern).toBe("__mcp__/*");
  });

  test("a bad value is rejected at startup, naming the flag", () => {
    expect(() => parseMcpSettings({ mcpEnforce: "yes" }, NO_ENV)).toThrow(/--mcp-enforce/);
    expect(() => parseMcpSettings({ mcpEnforce: "error", mcpCacheTtlMs: "soon" }, NO_ENV)).toThrow(
      /--mcp-cache-ttl-ms/,
    );
  });
});
