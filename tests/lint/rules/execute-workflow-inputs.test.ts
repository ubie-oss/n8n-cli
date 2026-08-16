import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import {
  executeWorkflowInputsExtraRule,
  executeWorkflowInputsMissingRule,
} from "@/lint/rules/execute-workflow-inputs.ts";

function workflow(id: string, nodes: Workflow["nodes"]): Workflow {
  return { id, name: `Workflow ${id}`, active: false, nodes, connections: {} };
}

function executeNode(
  inputs: Record<string, unknown>,
  workflowId = "callee",
): Workflow["nodes"][number] {
  return {
    id: "execute",
    name: "Execute child",
    type: "n8n-nodes-base.executeWorkflow",
    typeVersion: 1,
    position: [0, 0],
    parameters: { workflowId: { value: workflowId }, workflowInputs: { value: inputs } },
  };
}

function trigger(inputs: string[], acceptAll = false): Workflow["nodes"][number] {
  return {
    id: "trigger",
    name: "When executed by another workflow",
    type: "n8n-nodes-base.executeWorkflowTrigger",
    typeVersion: 1,
    position: [0, 0],
    parameters: { workflowInputs: { acceptAll, values: inputs.map((name) => ({ name })) } },
  };
}

describe("execute-workflow-inputs rules", () => {
  test("caller extra keys are errors", () => {
    const caller = workflow("caller", [executeNode({ expected: "ok", extra: "no" })]);
    const callee = workflow("callee", [trigger(["expected"])]);

    const violations = executeWorkflowInputsExtraRule.check(
      caller,
      "",
      {},
      { workflows: [caller, callee] },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      severity: "error",
      rule: "execute-workflow-inputs-extra",
    });
    expect(violations[0]!.message).toContain('"extra"');
  });

  test("caller missing declared keys are warnings", () => {
    const caller = workflow("caller", [executeNode({ expected: "ok" })]);
    const callee = workflow("callee", [trigger(["expected", "required"])]);

    const violations = executeWorkflowInputsMissingRule.check(
      caller,
      "",
      {},
      { workflows: [caller, callee] },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      severity: "warning",
      rule: "execute-workflow-inputs-missing",
    });
    expect(violations[0]!.message).toContain('"required"');
  });

  test("matching keys produce no violations", () => {
    const caller = workflow("caller", [executeNode({ expected: "ok" })]);
    const callee = workflow("callee", [trigger(["expected"])]);
    const context = { workflows: [caller, callee] };

    expect(executeWorkflowInputsExtraRule.check(caller, "", {}, context)).toEqual([]);
    expect(executeWorkflowInputsMissingRule.check(caller, "", {}, context)).toEqual([]);
  });

  test("unresolved or dynamic target and undeclared acceptAll input are skipped", () => {
    const unresolved = workflow("caller", [executeNode({ extra: "x" }, "not-found")]);
    const dynamic = workflow("dynamic", [executeNode({ extra: "x" }, "={{ $json.workflowId }}")]);
    const acceptAll = workflow("callee", [trigger([], true)]);
    const callerToAcceptAll = workflow("accept-caller", [executeNode({ extra: "x" })]);
    const context = { workflows: [unresolved, dynamic, acceptAll, callerToAcceptAll] };

    for (const caller of [unresolved, dynamic, callerToAcceptAll]) {
      expect(executeWorkflowInputsExtraRule.check(caller, "", {}, context)).toEqual([]);
      expect(executeWorkflowInputsMissingRule.check(caller, "", {}, context)).toEqual([]);
    }
  });
});
