import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { isMcpExposed, mcpExposureRule } from "@/lint/rules/mcp-exposure.ts";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "Test",
    active: true,
    nodes: [],
    connections: {},
    ...overrides,
  };
}

describe("isMcpExposed", () => {
  test("the setting alone is enough", () => {
    expect(isMcpExposed(makeWorkflow({ settings: { availableInMCP: true } }))).toBe(true);
  });

  test("a tag only counts when it was named", () => {
    const tagged = makeWorkflow({ tags: [{ name: "mcp" }] });
    expect(isMcpExposed(tagged)).toBe(false);
    expect(isMcpExposed(tagged, ["mcp"])).toBe(true);
    expect(isMcpExposed(tagged, ["mcp-tool"])).toBe(false);
  });

  test("a plain workflow is not exposed", () => {
    expect(isMcpExposed(makeWorkflow(), ["mcp"])).toBe(false);
  });
});

describe("mcp-exposure rule", () => {
  test("null workflow returns no violations", () => {
    expect(mcpExposureRule.check(null, "")).toEqual([]);
  });

  test("with no options it checks nothing", () => {
    const wf = makeWorkflow({ name: "anything", settings: { availableInMCP: true } });
    expect(mcpExposureRule.check(wf, "")).toEqual([]);
  });

  test("a workflow that is not exposed is left alone", () => {
    const wf = makeWorkflow({ name: "anything" });
    expect(
      mcpExposureRule.check(wf, "", { requireTags: ["mcp"], namePattern: "^\\[mcp\\]" }),
    ).toEqual([]);
  });

  test("an exposed workflow missing a required tag is flagged", () => {
    const wf = makeWorkflow({ settings: { availableInMCP: true } });
    const violations = mcpExposureRule.check(wf, "", { requireTags: ["mcp"] });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain('required tag "mcp"');
  });

  test("an exposed workflow carrying the tag passes", () => {
    const wf = makeWorkflow({ settings: { availableInMCP: true }, tags: [{ name: "mcp" }] });
    expect(mcpExposureRule.check(wf, "", { requireTags: ["mcp"] })).toEqual([]);
  });

  test("namePattern is enforced against the workflow name", () => {
    const wf = makeWorkflow({ name: "hospital lookup", settings: { availableInMCP: true } });
    const violations = mcpExposureRule.check(wf, "", { namePattern: "^\\[mcp\\] " });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("naming convention");

    const ok = makeWorkflow({ name: "[mcp] hospital lookup", settings: { availableInMCP: true } });
    expect(mcpExposureRule.check(ok, "", { namePattern: "^\\[mcp\\] " })).toEqual([]);
  });

  test("an unparseable namePattern is reported as a rule error, not a crash", () => {
    const wf = makeWorkflow({ settings: { availableInMCP: true } });
    const violations = mcpExposureRule.check(wf, "", { namePattern: "([" });
    expect(violations.length).toBe(1);
    expect(violations[0]?.severity).toBe("error");
    expect(violations[0]?.message).toContain("Invalid namePattern");
  });

  test("requireSetting catches a tag that promises access n8n refuses", () => {
    const wf = makeWorkflow({ tags: [{ name: "mcp" }] });
    const violations = mcpExposureRule.check(wf, "", {
      mcpTags: ["mcp"],
      requireSetting: true,
    });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("availableInMCP");
  });

  describe("entryPathPattern", () => {
    const webhook = (name: string, path?: string, disabled = false) => ({
      id: `n-${name}`,
      name,
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 0] as [number, number],
      parameters: path === undefined ? {} : { path },
      ...(disabled ? { disabled: true } : {}),
    });
    const exposed = (nodes: Workflow["nodes"]) =>
      makeWorkflow({ nodes, settings: { availableInMCP: true } });
    const OPT = { entryPathPattern: "__mcp__/*" };

    test("passes when the first supported trigger is the agent-facing one", () => {
      const wf = exposed([
        webhook("[MCP] entry", "__mcp__/lookup"),
        webhook("[CLI Test]", "__cli-test__/u"),
      ]);
      expect(mcpExposureRule.check(wf, "", OPT)).toEqual([]);
    });

    test("flags the case the whole rule exists for: the test hook is first", () => {
      // Same two nodes, opposite order. Nothing else about the workflow differs,
      // and nothing in a diff would show it — which is why this is checked.
      const wf = exposed([
        webhook("[CLI Test]", "__cli-test__/u"),
        webhook("[MCP] entry", "__mcp__/lookup"),
      ]);
      const violations = mcpExposureRule.check(wf, "", OPT);
      expect(violations.length).toBe(1);
      expect(violations[0]?.message).toContain('"[CLI Test]"');
      expect(violations[0]?.message).toContain("__cli-test__/u");
    });

    test("a Schedule entry is reported as having no path, with the way out named", () => {
      const wf = exposed([
        {
          id: "s",
          name: "Every night",
          type: "n8n-nodes-base.scheduleTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ]);
      const violations = mcpExposureRule.check(wf, "", OPT);
      expect(violations[0]?.message).toContain("declares no path");
      expect(violations[0]?.message).toContain("take it out of MCP");
    });

    test("a workflow n8n cannot enter at all is called out separately", () => {
      const wf = exposed([
        {
          id: "sub",
          name: "Called by another workflow",
          type: "n8n-nodes-base.executeWorkflowTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ]);
      expect(mcpExposureRule.check(wf, "", OPT)[0]?.message).toContain("no trigger n8n can enter");
    });

    test("a disabled trigger does not count as the entry", () => {
      const wf = exposed([
        webhook("[MCP] disabled", "__mcp__/lookup", true),
        webhook("[CLI Test]", "__cli-test__/u"),
      ]);
      expect(mcpExposureRule.check(wf, "", OPT)[0]?.message).toContain('"[CLI Test]"');
    });

    test("the check is off unless the pattern is configured", () => {
      const wf = exposed([webhook("[CLI Test]", "__cli-test__/u")]);
      expect(mcpExposureRule.check(wf, "")).toEqual([]);
      expect(mcpExposureRule.check(wf, "", { entryPathPattern: "" })).toEqual([]);
    });
  });

  test("requireSetting is satisfied once the setting is on", () => {
    const wf = makeWorkflow({ tags: [{ name: "mcp" }], settings: { availableInMCP: true } });
    expect(mcpExposureRule.check(wf, "", { mcpTags: ["mcp"], requireSetting: true })).toEqual([]);
  });
});
