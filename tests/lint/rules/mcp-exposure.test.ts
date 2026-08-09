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

  test("requireSetting is satisfied once the setting is on", () => {
    const wf = makeWorkflow({ tags: [{ name: "mcp" }], settings: { availableInMCP: true } });
    expect(mcpExposureRule.check(wf, "", { mcpTags: ["mcp"], requireSetting: true })).toEqual([]);
  });
});
