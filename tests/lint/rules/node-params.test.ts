import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { nodeParamsRule } from "@/lint/rules/node-params.ts";

function makeWorkflow(nodes: Workflow["nodes"]): Workflow {
  return { name: "Test", active: false, nodes, connections: {} };
}

describe("node-params rule", () => {
  test("name is node-params", () => {
    expect(nodeParamsRule.name).toBe("node-params");
  });

  test("default severity is warning", () => {
    expect(nodeParamsRule.defaultSeverity).toBe("warning");
  });

  test("null workflow returns no violations", () => {
    expect(nodeParamsRule.check(null, "").length).toBe(0);
  });

  test("unknown node type - no violations", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Custom",
        type: "n8n-nodes-base.customType",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("code node with jsCode - no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [0, 0],
        parameters: { jsCode: "return [{ json: {} }];" },
      },
    ]);
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("code node missing jsCode - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("jsCode");
    expect(violations[0]!.message).toContain("missing required");
  });

  test("code node with empty jsCode - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 1,
        position: [0, 0],
        parameters: { jsCode: "" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("jsCode");
    expect(violations[0]!.message).toContain("empty");
  });

  test("httpRequest with valid parameters - no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "HTTP Request",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [0, 0],
        parameters: { url: "https://example.com", method: "GET" },
      },
    ]);
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("httpRequest missing url - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "HTTP Request",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [0, 0],
        parameters: { method: "GET" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("url"))).toBe(true);
  });

  test("httpRequest invalid method enum - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "HTTP Request",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [0, 0],
        parameters: { url: "https://example.com", method: "INVALID" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("method");
    expect(violations[0]!.message).toContain("INVALID");
    expect(violations[0]!.message).toContain("allowed");
  });

  test("slack node missing credentials - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Slack",
        type: "n8n-nodes-base.slack",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          channelId: { value: "C123" },
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("slack node with credentials - no credential violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Slack",
        type: "n8n-nodes-base.slack",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          channelId: { value: "C123" },
        },
        credentials: { slackApi: { id: "1", name: "Slack" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(false);
  });

  test("executeWorkflow with nested required fields - no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Execute",
        type: "n8n-nodes-base.executeWorkflow",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          workflowId: { value: "abc123" },
        },
      },
    ]);
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("executeWorkflow missing nested value - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Execute",
        type: "n8n-nodes-base.executeWorkflow",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          workflowId: { mode: "id" },
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("nested key") && v.message.includes("value")),
    ).toBe(true);
  });

  test("expression value skips type/enum check", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "HTTP Request",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 1,
        position: [0, 0],
        parameters: { url: "https://example.com", method: "={{ $json.method }}" },
      },
    ]);
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("version filtering - set v3 requires assignments", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 3,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("assignments"))).toBe(true);
  });

  test("version filtering - set v1 does not require assignments", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Set",
        type: "n8n-nodes-base.set",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    // v1 has no schema (minVersion 3)
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("AI Agent required params - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "AI Agent",
        type: "@n8n/n8n-nodes-langchain.agent",
        typeVersion: 3,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("promptType"))).toBe(true);
    expect(violations.some((v) => v.message.includes("text"))).toBe(true);
  });

  // --- getNodeParameters structure validation tests ---

  test("Notion matchType nested inside filters (wrong hierarchy) - violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Notion DB",
        type: "n8n-nodes-base.notion",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          resource: "databasePage",
          operation: "getAll",
          filterType: "manual",
          filters: {
            matchType: "anyFilter",
            conditions: [
              { key: "title|title", type: "title", condition: "equals", titleValue: "test" },
            ],
          },
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("Could not find property option"))).toBe(true);
  });

  test("Notion matchType at top level (correct hierarchy) - no structure violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Notion DB",
        type: "n8n-nodes-base.notion",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          resource: "databasePage",
          operation: "getAll",
          filterType: "manual",
          matchType: "anyFilter",
          filters: {
            conditions: [
              { key: "title|title", type: "title", condition: "equals", titleValue: "test" },
            ],
          },
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("Could not find property option"))).toBe(
      false,
    );
  });

  test("unknown node type - getNodeParameters check is skipped", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Custom",
        type: "n8n-nodes-base.nonExistentNode",
        typeVersion: 1,
        position: [0, 0],
        parameters: { foo: "bar" },
      },
    ]);
    expect(nodeParamsRule.check(wf, "").length).toBe(0);
  });

  test("condition-based schema - slack file mode", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Slack",
        type: "n8n-nodes-base.slack",
        typeVersion: 1,
        position: [0, 0],
        parameters: { resource: "file" },
        credentials: { slackApi: { id: "1", name: "Slack" } },
      },
    ]);
    // file mode has requiresCredentials only, no channelId requirement
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("channelId"))).toBe(false);
  });
});
