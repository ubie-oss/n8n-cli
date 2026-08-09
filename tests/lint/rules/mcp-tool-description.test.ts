import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { mcpToolDescriptionRule } from "@/lint/rules/mcp-tool-description.ts";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "Test",
    active: true,
    nodes: [],
    connections: {},
    ...overrides,
  };
}

const exposed = (description?: string, extra: Partial<Workflow> = {}): Workflow =>
  makeWorkflow({ description, settings: { availableInMCP: true }, ...extra });

describe("mcp-tool-description rule", () => {
  test("name is mcp-tool-description", () => {
    expect(mcpToolDescriptionRule.name).toBe("mcp-tool-description");
  });

  test("null workflow returns no violations", () => {
    expect(mcpToolDescriptionRule.check(null, "")).toEqual([]);
  });

  test("a workflow not exposed over MCP is not asked for a description", () => {
    expect(mcpToolDescriptionRule.check(makeWorkflow(), "")).toEqual([]);
    expect(
      mcpToolDescriptionRule.check(makeWorkflow({ settings: { availableInMCP: false } }), ""),
    ).toEqual([]);
  });

  test("an exposed workflow with no description is flagged", () => {
    const violations = mcpToolDescriptionRule.check(exposed(), "");
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("no description");
  });

  test("whitespace is not a description", () => {
    expect(mcpToolDescriptionRule.check(exposed("   \n  "), "").length).toBe(1);
  });

  test("an exposed workflow with a real description passes", () => {
    const violations = mcpToolDescriptionRule.check(
      exposed("Looks up a hospital by name in Salesforce and returns its contract status."),
      "",
    );
    expect(violations).toEqual([]);
  });

  test("a description shorter than minLength is flagged", () => {
    const violations = mcpToolDescriptionRule.check(exposed("too short"), "");
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("shorter than");
  });

  test("minLength: 0 disables the length floor", () => {
    expect(mcpToolDescriptionRule.check(exposed("short"), "", { minLength: 0 })).toEqual([]);
  });

  test("a description past n8n's 255-character limit is flagged", () => {
    const violations = mcpToolDescriptionRule.check(exposed("a".repeat(256)), "");
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("truncates at 255");
  });

  test("length is counted in code points, not UTF-8 bytes", () => {
    // 200 Japanese characters are 600 bytes but well inside n8n's limit.
    expect(mcpToolDescriptionRule.check(exposed("あ".repeat(200)), "")).toEqual([]);
    expect(mcpToolDescriptionRule.check(exposed("あ".repeat(256)), "").length).toBe(1);
  });

  test("mcpTags makes a tagged workflow count as exposed", () => {
    const tagged = makeWorkflow({ tags: [{ name: "mcp" }] });
    expect(mcpToolDescriptionRule.check(tagged, "")).toEqual([]);
    const violations = mcpToolDescriptionRule.check(tagged, "", { mcpTags: ["mcp"] });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("no description");
  });

  test("a malformed option is ignored rather than thrown", () => {
    expect(() =>
      mcpToolDescriptionRule.check(exposed("a".repeat(30)), "", {
        mcpTags: "mcp",
        minLength: -5,
        maxLength: "lots",
      }),
    ).not.toThrow();
  });
});
