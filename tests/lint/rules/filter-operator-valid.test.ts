import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { filterOperatorValidRule } from "@/lint/rules/filter-operator-valid.ts";

function makeWorkflow(nodes: Workflow["nodes"]): Workflow {
  return { name: "Test", active: false, nodes, connections: {} };
}

function makeFilterNode(
  overrides: { name?: string; type?: string; typeVersion?: number; conditions?: unknown } = {},
) {
  return {
    id: "1",
    name: overrides.name ?? "If",
    type: overrides.type ?? "n8n-nodes-base.if",
    typeVersion: overrides.typeVersion ?? 2,
    position: [0, 0] as [number, number],
    parameters: overrides.conditions !== undefined ? { conditions: overrides.conditions } : {},
  };
}

function makeConditions(items: Array<{ type: string; operation: string }>) {
  return {
    conditions: items.map((item) => ({
      leftValue: "",
      rightValue: "",
      operator: { type: item.type, operation: item.operation },
    })),
  };
}

describe("filter-operator-valid rule", () => {
  test("name is filter-operator-valid", () => {
    expect(filterOperatorValidRule.name).toBe("filter-operator-valid");
  });

  test("default severity is error", () => {
    expect(filterOperatorValidRule.defaultSeverity).toBe("error");
  });

  test("null workflow returns no violations", () => {
    expect(filterOperatorValidRule.check(null, "")).toEqual([]);
  });

  test("non-target node type returns no violations", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [0, 0],
        parameters: {},
      },
    ]);
    expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
  });

  test("typeVersion < 2 returns no violations", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        typeVersion: 1,
        conditions: makeConditions([{ type: "string", operation: "isNotEmpty" }]),
      }),
    ]);
    expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
  });

  test("valid string operations produce no violations", () => {
    const ops = [
      "empty",
      "notEmpty",
      "equals",
      "notEquals",
      "contains",
      "notContains",
      "startsWith",
      "notStartsWith",
      "endsWith",
      "notEndsWith",
      "regex",
      "notRegex",
      "exists",
      "notExists",
    ];
    for (const op of ops) {
      const wf = makeWorkflow([
        makeFilterNode({ conditions: makeConditions([{ type: "string", operation: op }]) }),
      ]);
      expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
    }
  });

  test("valid boolean operations produce no violations", () => {
    const ops = [
      "empty",
      "notEmpty",
      "true",
      "false",
      "equals",
      "notEquals",
      "exists",
      "notExists",
    ];
    for (const op of ops) {
      const wf = makeWorkflow([
        makeFilterNode({ conditions: makeConditions([{ type: "boolean", operation: op }]) }),
      ]);
      expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
    }
  });

  test("valid number operations produce no violations", () => {
    const ops = [
      "empty",
      "notEmpty",
      "equals",
      "notEquals",
      "gt",
      "lt",
      "gte",
      "lte",
      "exists",
      "notExists",
    ];
    for (const op of ops) {
      const wf = makeWorkflow([
        makeFilterNode({ conditions: makeConditions([{ type: "number", operation: op }]) }),
      ]);
      expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
    }
  });

  test("valid dateTime operations produce no violations", () => {
    const ops = [
      "empty",
      "notEmpty",
      "equals",
      "notEquals",
      "after",
      "before",
      "afterOrEquals",
      "beforeOrEquals",
      "exists",
      "notExists",
    ];
    for (const op of ops) {
      const wf = makeWorkflow([
        makeFilterNode({ conditions: makeConditions([{ type: "dateTime", operation: op }]) }),
      ]);
      expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
    }
  });

  test("valid array operations produce no violations", () => {
    const ops = [
      "contains",
      "notContains",
      "lengthEquals",
      "lengthNotEquals",
      "lengthGt",
      "lengthLt",
      "lengthGte",
      "lengthLte",
      "empty",
      "notEmpty",
      "exists",
      "notExists",
    ];
    for (const op of ops) {
      const wf = makeWorkflow([
        makeFilterNode({ conditions: makeConditions([{ type: "array", operation: op }]) }),
      ]);
      expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
    }
  });

  test("valid object operations produce no violations", () => {
    const ops = ["empty", "notEmpty", "exists", "notExists"];
    for (const op of ops) {
      const wf = makeWorkflow([
        makeFilterNode({ conditions: makeConditions([{ type: "object", operation: op }]) }),
      ]);
      expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
    }
  });

  test("invalid string operation produces violation", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        conditions: makeConditions([{ type: "string", operation: "isNotEmpty" }]),
      }),
    ]);
    const violations = filterOperatorValidRule.check(wf, "");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("filter-operator-valid");
    expect(violations[0]!.severity).toBe("error");
    expect(violations[0]!.message).toContain("If");
    expect(violations[0]!.message).toContain("string");
    expect(violations[0]!.message).toContain("isNotEmpty");
  });

  test("invalid number operation produces violation", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        conditions: makeConditions([{ type: "number", operation: "isGreaterThan" }]),
      }),
    ]);
    const violations = filterOperatorValidRule.check(wf, "");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("number");
    expect(violations[0]!.message).toContain("isGreaterThan");
  });

  test("multiple conditions with some invalid produces violations only for invalid ones", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        conditions: makeConditions([
          { type: "string", operation: "notEmpty" },
          { type: "string", operation: "isNotEmpty" },
          { type: "number", operation: "gt" },
          { type: "number", operation: "isGreaterThan" },
        ]),
      }),
    ]);
    const violations = filterOperatorValidRule.check(wf, "");
    expect(violations).toHaveLength(2);
    expect(violations[0]!.message).toContain("isNotEmpty");
    expect(violations[1]!.message).toContain("isGreaterThan");
  });

  test("unknown operator type is skipped (no false positive)", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        conditions: makeConditions([{ type: "futureType", operation: "futureOp" }]),
      }),
    ]);
    expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
  });

  test("missing operator in condition is skipped", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        conditions: {
          conditions: [{ leftValue: "", rightValue: "" }],
        },
      }),
    ]);
    expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
  });

  test("missing conditions is skipped", () => {
    const wf = makeWorkflow([makeFilterNode({ conditions: undefined })]);
    expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
  });

  test("conditions without nested conditions array is skipped", () => {
    const wf = makeWorkflow([makeFilterNode({ conditions: { combinator: "and" } })]);
    expect(filterOperatorValidRule.check(wf, "")).toEqual([]);
  });

  test("works with n8n-nodes-base.if", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        type: "n8n-nodes-base.if",
        conditions: makeConditions([{ type: "string", operation: "isNotEmpty" }]),
      }),
    ]);
    expect(filterOperatorValidRule.check(wf, "")).toHaveLength(1);
  });

  test("works with n8n-nodes-base.filter", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        name: "Filter",
        type: "n8n-nodes-base.filter",
        conditions: makeConditions([{ type: "string", operation: "isNotEmpty" }]),
      }),
    ]);
    const violations = filterOperatorValidRule.check(wf, "");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("Filter");
    expect(violations[0]!.message).toContain("n8n-nodes-base.filter");
  });

  test("message contains node name, type, and operation", () => {
    const wf = makeWorkflow([
      makeFilterNode({
        name: "MyIf",
        conditions: makeConditions([{ type: "boolean", operation: "isTrue" }]),
      }),
    ]);
    const violations = filterOperatorValidRule.check(wf, "");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("MyIf");
    expect(violations[0]!.message).toContain("boolean");
    expect(violations[0]!.message).toContain("isTrue");
  });
});
