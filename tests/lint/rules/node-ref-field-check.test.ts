import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { nodeRefFieldCheckRule } from "@/lint/rules/node-ref-field-check.ts";

describe("node-ref-field-check rule", () => {
  test("name is node-ref-field-check", () => {
    expect(nodeRefFieldCheckRule.name).toBe("node-ref-field-check");
  });

  test("default severity is warning", () => {
    expect(nodeRefFieldCheckRule.defaultSeverity).toBe("warning");
  });

  test("null workflow returns no violations", () => {
    expect(nodeRefFieldCheckRule.check(null, "").length).toBe(0);
  });

  test("correct field reference on AI Agent - no violation", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          position: [200, 0],
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('AI Agent').item.json.output }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "AI Agent", type: "main", index: 0 }]] },
        "AI Agent": { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("incorrect field reference on AI Agent - violation", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          position: [200, 0],
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('AI Agent').item.json.text }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "AI Agent", type: "main", index: 0 }]] },
        "AI Agent": { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    const violations = nodeRefFieldCheckRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("text");
    expect(violations[0]!.message).toContain("AI Agent");
    expect(violations[0]!.message).toContain("output");
  });

  test("sub-field of output on AI Agent - no violation", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          position: [200, 0],
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('AI Agent').item.json.output.summary }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "AI Agent", type: "main", index: 0 }]] },
        "AI Agent": { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("dynamic fields node - no violation (skip check)", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "Code",
          type: "n8n-nodes-base.code",
          typeVersion: 1,
          position: [200, 0],
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('Code').item.json.anyField }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Code", type: "main", index: 0 }]] },
        Code: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("Set without includeOtherFields reports a field it drops", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 3.4,
          position: [0, 0],
          parameters: {
            assignments: { assignments: [{ name: "kept", value: "ok", type: "string" }] },
          },
        },
        {
          id: "2",
          name: "Consumer",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4,
          position: [200, 0],
          parameters: { url: "={{ $('Set').item.json.dropped }}" },
        },
      ],
      connections: { Set: { main: [[{ node: "Consumer", type: "main", index: 0 }]] } },
    };

    const violations = nodeRefFieldCheckRule.check(wf, "");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("dropped");
    expect(violations[0]?.message).toContain("kept");
  });

  test("Set with includeOtherFields keeps unknown input fields", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 3.4,
          position: [0, 0],
          parameters: {
            includeOtherFields: true,
            assignments: { assignments: [{ name: "kept", value: "ok", type: "string" }] },
          },
        },
        {
          id: "2",
          name: "Consumer",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4,
          position: [200, 0],
          parameters: { url: "={{ $('Set').item.json.inputField }}" },
        },
      ],
      connections: { Set: { main: [[{ node: "Consumer", type: "main", index: 0 }]] } },
    };

    expect(nodeRefFieldCheckRule.check(wf, "")).toHaveLength(0);
  });

  test("unknown node type - no violation (skip check)", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "Custom",
          type: "n8n-nodes-base.customNode",
          typeVersion: 1,
          position: [200, 0],
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('Custom').item.json.anyField }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Custom", type: "main", index: 0 }]] },
        Custom: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("aggregate node with custom destination field", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "Aggregate",
          type: "n8n-nodes-base.aggregate",
          typeVersion: 1,
          position: [200, 0],
          parameters: { destinationFieldName: "results" },
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('Aggregate').first().json.results }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Aggregate", type: "main", index: 0 }]] },
        Aggregate: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("aggregate node with wrong field - violation", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
        },
        {
          id: "2",
          name: "Aggregate",
          type: "n8n-nodes-base.aggregate",
          typeVersion: 1,
          position: [200, 0],
          parameters: { destinationFieldName: "results" },
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [400, 0],
          parameters: { value: "={{ $('Aggregate').first().json.wrongField }}" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Aggregate", type: "main", index: 0 }]] },
        Aggregate: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    };
    const violations = nodeRefFieldCheckRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("wrongField");
    expect(violations[0]!.message).toContain("Aggregate");
    expect(violations[0]!.message).toContain("results");
  });

  test("non-existent referenced node - no violation (deferred to connection-ref)", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [0, 0],
          parameters: { value: "={{ $('NonExistent').item.json.field }}" },
        },
      ],
      connections: {},
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("sticky note is excluded", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          position: [0, 0],
        },
        {
          id: "2",
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          typeVersion: 1,
          position: [0, 200],
          parameters: { content: "={{ $('AI Agent').item.json.text }}" },
        },
      ],
      connections: {},
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });

  test("inputSchema parameter is excluded", () => {
    const wf: Workflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "AI Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          position: [0, 0],
        },
        {
          id: "2",
          name: "Parser",
          type: "@n8n/n8n-nodes-langchain.outputParserStructured",
          typeVersion: 1,
          position: [200, 200],
          parameters: { inputSchema: "={{ $('AI Agent').item.json.text }}" },
        },
      ],
      connections: {},
    };
    expect(nodeRefFieldCheckRule.check(wf, "").length).toBe(0);
  });
});
