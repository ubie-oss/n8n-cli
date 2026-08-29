import { describe, expect, test } from "bun:test";
import { resolveMcpCliOptions } from "@/cli/commands/proxy.ts";
import { parseMcpSettings } from "@/proxy/mcp/config.ts";

/**
 * The `.n8nctlrc.json` `proxy.mcp` section feeds the same parser the flags
 * use, folded at the lowest precedence: CLI flag > env var > config file.
 * Exported via `resolveMcpCliOptions` — the same testable-seam pattern the
 * middleware CLI-option extractors use.
 */
describe("resolveMcpCliOptions precedence", () => {
  const file = {
    enforce: "error" as const,
    allowTools: ["search_workflows", "get_workflow_details"],
    workflowTags: ["mcp"],
    entryPathPattern: "__mcp__/*",
    cacheTtlMs: 12_000,
  };

  test("file section supplies values the flags and env do not set", () => {
    const merged = resolveMcpCliOptions({}, {}, file);
    expect(merged).toEqual({
      mcpEnforce: "error",
      mcpAllowTools: "search_workflows,get_workflow_details",
      mcpDenyTools: undefined,
      mcpWorkflowTags: "mcp",
      mcpEntryPathPattern: "__mcp__/*",
      mcpCacheTtlMs: "12000",
    });
  });

  test("flag beats file", () => {
    const merged = resolveMcpCliOptions({ mcpEnforce: "warn" }, {}, file);
    expect(merged.mcpEnforce).toBe("warn");
    // unset fields still come from the file
    expect(merged.mcpAllowTools).toBe("search_workflows,get_workflow_details");
  });

  test("env beats file", () => {
    const merged = resolveMcpCliOptions({}, { N8N_MCP_ENFORCE: "off" }, file);
    expect(merged.mcpEnforce).toBe("off");
  });

  test("flag beats env beats file", () => {
    const merged = resolveMcpCliOptions({ mcpEnforce: "warn" }, { N8N_MCP_ENFORCE: "off" }, file);
    expect(merged.mcpEnforce).toBe("warn");
  });

  test("no file section leaves flags and env untouched", () => {
    const merged = resolveMcpCliOptions(
      { mcpEnforce: "warn" },
      { N8N_MCP_ALLOW_TOOLS: "a,b" },
      undefined,
    );
    expect(merged).toEqual({ mcpEnforce: "warn", mcpAllowTools: "a,b" });
  });
});

describe("parseMcpSettings with file-sourced options", () => {
  test("a file policy builds gate settings when enforce comes from the file too", () => {
    const merged = resolveMcpCliOptions(
      {},
      {},
      { enforce: "error", allowTools: ["search_workflows"], workflowTags: ["mcp"] },
    );
    const settings = parseMcpSettings(merged, {});
    expect(settings).not.toBeNull();
    expect(settings!.enforce).toBe("error");
    expect(settings!.policy.allowTools).toEqual(["search_workflows"]);
    expect(settings!.policy.workflowTags).toEqual(["mcp"]);
  });

  test("a file policy without any enforce refuses to start (orphan check)", () => {
    const merged = resolveMcpCliOptions({}, {}, { allowTools: ["search_workflows"] });
    expect(() => parseMcpSettings(merged, {})).toThrow(
      /MCP policy is configured .*--mcp-enforce \/ N8N_MCP_ENFORCE .*proxy\.mcp\.enforce/,
    );
  });
});
