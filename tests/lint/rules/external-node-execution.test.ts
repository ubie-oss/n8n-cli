import { describe, expect, test } from "bun:test";
import type { Node, Workflow } from "@/api/types.ts";
import {
  externalNodeRepeatedCallRule,
  externalNodeStaticRepeatedCallRule,
} from "@/lint/rules/external-node-execution.ts";

function workflow(external: Node): Workflow {
  return {
    name: "Test",
    active: false,
    nodes: [
      {
        id: "1",
        name: "Query rows",
        type: "n8n-nodes-base.googleBigQuery",
        typeVersion: 2,
        position: [0, 0],
        parameters: { operation: "executeQuery" },
      },
      {
        id: "2",
        name: "Pass through",
        type: "n8n-nodes-base.set",
        typeVersion: 3.4,
        position: [200, 0],
        parameters: { includeOtherFields: true, assignments: { assignments: [] } },
      },
      external,
    ],
    connections: {
      "Query rows": { main: [[{ node: "Pass through", type: "main", index: 0 }]] },
      "Pass through": { main: [[{ node: external.name, type: "main", index: 0 }]] },
    },
  };
}

function http(parameters: Record<string, unknown>, executeOnce = false): Node {
  return {
    id: "3",
    name: "HTTP",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4,
    position: [400, 0],
    parameters,
    executeOnce,
  };
}

describe("external node execution rules", () => {
  test("input-dependent repeated call is a warning", () => {
    const wf = workflow(http({ url: "={{ $json.url }}" }));
    expect(externalNodeRepeatedCallRule.check(wf, "")).toHaveLength(1);
    expect(externalNodeStaticRepeatedCallRule.check(wf, "")).toHaveLength(0);
  });

  test("input-independent repeated call is an error", () => {
    const wf = workflow(http({ url: "https://example.com/static" }));
    expect(externalNodeRepeatedCallRule.check(wf, "")).toHaveLength(0);
    const violations = externalNodeStaticRepeatedCallRule.check(wf, "");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("error");
  });

  test("executeOnce suppresses both findings", () => {
    const wf = workflow(http({ url: "https://example.com/static" }, true));
    expect(externalNodeRepeatedCallRule.check(wf, "")).toHaveLength(0);
    expect(externalNodeStaticRepeatedCallRule.check(wf, "")).toHaveLength(0);
  });

  test("single-item upstream does not trigger", () => {
    const wf = workflow(http({ url: "https://example.com/static" }));
    wf.nodes[0] = {
      id: "1",
      name: "Query rows",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 0],
    };
    expect(externalNodeStaticRepeatedCallRule.check(wf, "")).toHaveLength(0);
  });
});
