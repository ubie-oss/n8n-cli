import { describe, expect, test } from "bun:test";
import { parseMcpSettings } from "@/proxy/mcp/config.ts";
import {
  DEFAULT_WORKFLOW_ID_ARGS,
  globMatch,
  hasWorkflowScope,
  isToolAllowed,
  type McpPolicy,
  targetWorkflowId,
} from "@/proxy/mcp/policy.ts";

const NO_ENV = {} as NodeJS.ProcessEnv;

function policy(overrides: Partial<McpPolicy> = {}): McpPolicy {
  return {
    allowTools: [],
    denyTools: [],
    workflowTags: [],
    requireAvailableInMCP: false,
    workflowIdArgs: DEFAULT_WORKFLOW_ID_ARGS,
    onMissingTarget: "deny",
    ...overrides,
  };
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
  test("undefined for a tool that targets no workflow", () => {
    expect(targetWorkflowId(policy(), "search_workflows", { workflowId: "x" })).toBeUndefined();
  });

  test("null when the tool targets one but the call named none", () => {
    expect(targetWorkflowId(policy(), "execute_workflow", {})).toBeNull();
    expect(targetWorkflowId(policy(), "execute_workflow", { workflowId: "" })).toBeNull();
  });

  test("falls back to `id`", () => {
    expect(targetWorkflowId(policy(), "execute_workflow", { id: "wf1" })).toBe("wf1");
  });

  test("a numeric id is still an id", () => {
    expect(targetWorkflowId(policy(), "execute_workflow", { workflowId: 7 })).toBe("7");
  });
});

describe("hasWorkflowScope", () => {
  test("false until something scopes workflows", () => {
    expect(hasWorkflowScope(policy())).toBe(false);
    expect(hasWorkflowScope(policy({ denyTools: ["*"] }))).toBe(false);
    expect(hasWorkflowScope(policy({ workflowTags: ["mcp"] }))).toBe(true);
    expect(hasWorkflowScope(policy({ workflowNamePattern: "^x" }))).toBe(true);
    expect(hasWorkflowScope(policy({ requireAvailableInMCP: true }))).toBe(true);
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
        mcpPathPrefix: "mcp",
        mcpAllowTools: "search_workflows, execute_workflow",
        mcpDenyTools: "*credential*",
        mcpWorkflowTags: "mcp,prod",
        mcpWorkflowNamePattern: "^\\[mcp\\] ",
        mcpRequireAvailableInMcp: true,
        mcpOnMissingTarget: "allow",
        mcpOnIndexError: "allow",
        mcpCacheTtlMs: "5000",
      },
      NO_ENV,
    );

    expect(settings?.enforce).toBe("error");
    // A prefix is normalised on both ends so path matching is unambiguous.
    expect(settings?.pathPrefix).toBe("/mcp/");
    expect(settings?.policy.allowTools).toEqual(["search_workflows", "execute_workflow"]);
    expect(settings?.policy.denyTools).toEqual(["*credential*"]);
    expect(settings?.policy.workflowTags).toEqual(["mcp", "prod"]);
    expect(settings?.policy.requireAvailableInMCP).toBe(true);
    expect(settings?.policy.onMissingTarget).toBe("allow");
    expect(settings?.onIndexError).toBe("allow");
    expect(settings?.cacheTtlMs).toBe(5000);
  });

  test("falls back to the environment", () => {
    const settings = parseMcpSettings({}, {
      N8N_MCP_ENFORCE: "warn",
      N8N_MCP_WORKFLOW_TAGS: "mcp",
      N8N_MCP_REQUIRE_AVAILABLE_IN_MCP: "true",
    } as NodeJS.ProcessEnv);

    expect(settings?.enforce).toBe("warn");
    expect(settings?.policy.workflowTags).toEqual(["mcp"]);
    expect(settings?.policy.requireAvailableInMCP).toBe(true);
    expect(settings?.pathPrefix).toBe("/mcp-server/");
  });

  test("the built-in tool→argument map is the default", () => {
    const settings = parseMcpSettings({ mcpEnforce: "error" }, NO_ENV);
    expect(settings?.policy.workflowIdArgs.execute_workflow).toEqual(["workflowId", "id"]);
  });

  test("a custom tool→argument map is merged over the built-in one", () => {
    const settings = parseMcpSettings(
      { mcpEnforce: "error", mcpWorkflowIdArgs: '{"run_workflow":["wfId"],"archive_workflow":[]}' },
      NO_ENV,
    );
    expect(settings?.policy.workflowIdArgs.run_workflow).toEqual(["wfId"]);
    // Still known, because the map is additive.
    expect(settings?.policy.workflowIdArgs.execute_workflow).toEqual(["workflowId", "id"]);
    // An empty list opts a tool out of the scope check entirely.
    expect(settings?.policy.workflowIdArgs.archive_workflow).toBeUndefined();
  });

  test("a bad value is rejected at startup, naming the flag", () => {
    expect(() => parseMcpSettings({ mcpEnforce: "yes" }, NO_ENV)).toThrow(/--mcp-enforce/);
    expect(() =>
      parseMcpSettings({ mcpEnforce: "error", mcpWorkflowNamePattern: "([" }, NO_ENV),
    ).toThrow(/--mcp-workflow-name-pattern/);
    expect(() =>
      parseMcpSettings({ mcpEnforce: "error", mcpOnIndexError: "maybe" }, NO_ENV),
    ).toThrow(/--mcp-on-index-error/);
    expect(() =>
      parseMcpSettings({ mcpEnforce: "error", mcpWorkflowIdArgs: "[]" }, NO_ENV),
    ).toThrow(/--mcp-workflow-id-args/);
    expect(() =>
      parseMcpSettings({ mcpEnforce: "error", mcpWorkflowIdArgs: '{"a":"b"}' }, NO_ENV),
    ).toThrow(/array of strings/);
    expect(() => parseMcpSettings({ mcpEnforce: "error", mcpCacheTtlMs: "soon" }, NO_ENV)).toThrow(
      /--mcp-cache-ttl-ms/,
    );
  });
});
