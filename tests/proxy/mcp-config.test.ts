import { describe, expect, test } from "bun:test";
import { parseMcpSettings } from "@/proxy/mcp/config.ts";
import {
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

describe("hasWorkflowScope", () => {
  test("false until a tag scopes workflows", () => {
    expect(hasWorkflowScope(policy())).toBe(false);
    expect(hasWorkflowScope(policy({ denyTools: ["*"] }))).toBe(false);
    expect(hasWorkflowScope(policy({ workflowTags: ["mcp"] }))).toBe(true);
  });
});

describe("parseMcpSettings", () => {
  test("no gate unless enforcement is asked for", () => {
    expect(parseMcpSettings({ mcpAllowTools: "search_workflows" }, NO_ENV)).toBeNull();
  });

  test("reads the whole policy off the flags", () => {
    const settings = parseMcpSettings(
      {
        mcpEnforce: "error",
        mcpAllowTools: "search_workflows, execute_workflow",
        mcpDenyTools: "*credential*",
        mcpWorkflowTags: "mcp,prod",
        mcpCacheTtlMs: "5000",
      },
      NO_ENV,
    );

    expect(settings?.enforce).toBe("error");
    expect(settings?.policy.allowTools).toEqual(["search_workflows", "execute_workflow"]);
    expect(settings?.policy.denyTools).toEqual(["*credential*"]);
    expect(settings?.policy.workflowTags).toEqual(["mcp", "prod"]);
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

  test("a bad value is rejected at startup, naming the flag", () => {
    expect(() => parseMcpSettings({ mcpEnforce: "yes" }, NO_ENV)).toThrow(/--mcp-enforce/);
    expect(() => parseMcpSettings({ mcpEnforce: "error", mcpCacheTtlMs: "soon" }, NO_ENV)).toThrow(
      /--mcp-cache-ttl-ms/,
    );
  });
});
