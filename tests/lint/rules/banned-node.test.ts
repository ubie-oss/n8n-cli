import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { bannedNodeRule } from "@/lint/rules/banned-node.ts";

function makeWorkflow(nodes: Array<{ name: string; type: string }>): Workflow {
  return {
    name: "Test",
    active: true,
    nodes: nodes.map((n, i) => ({
      id: String(i + 1),
      name: n.name,
      type: n.type,
      typeVersion: 1,
      position: [0, 0] as [number, number],
    })),
    connections: {},
  };
}

describe("banned-node rule", () => {
  test("name is banned-node", () => {
    expect(bannedNodeRule.name).toBe("banned-node");
  });

  test("null workflow returns empty array", () => {
    expect(bannedNodeRule.check(null, "")).toEqual([]);
  });

  test("no options returns empty array", () => {
    const wf = makeWorkflow([{ name: "Code", type: "n8n-nodes-base.code" }]);
    expect(bannedNodeRule.check(wf, "")).toEqual([]);
  });

  test("empty nodes array returns empty array", () => {
    const wf = makeWorkflow([{ name: "Code", type: "n8n-nodes-base.code" }]);
    expect(bannedNodeRule.check(wf, "", { nodes: [] })).toEqual([]);
  });

  test("detects a banned node", () => {
    const wf = makeWorkflow([{ name: "Run Command", type: "n8n-nodes-base.executeCommand" }]);
    const violations = bannedNodeRule.check(wf, "", {
      nodes: [{ type: "n8n-nodes-base.executeCommand", reason: "Security risk" }],
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.rule).toBe("banned-node");
  });

  test("message includes reason when provided", () => {
    const wf = makeWorkflow([{ name: "Run Command", type: "n8n-nodes-base.executeCommand" }]);
    const violations = bannedNodeRule.check(wf, "", {
      nodes: [{ type: "n8n-nodes-base.executeCommand", reason: "Security risk" }],
    });
    expect(violations[0]!.message).toBe(
      'Node "Run Command" uses banned type "n8n-nodes-base.executeCommand": Security risk',
    );
  });

  test("message omits reason when not provided", () => {
    const wf = makeWorkflow([{ name: "SSH", type: "n8n-nodes-base.ssh" }]);
    const violations = bannedNodeRule.check(wf, "", {
      nodes: [{ type: "n8n-nodes-base.ssh" }],
    });
    expect(violations[0]!.message).toBe('Node "SSH" uses banned type "n8n-nodes-base.ssh"');
  });

  test("non-banned node returns no violations", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      nodes: [{ type: "n8n-nodes-base.executeCommand" }],
    });
    expect(violations.length).toBe(0);
  });

  test("multiple banned nodes produce multiple violations", () => {
    const wf = makeWorkflow([
      { name: "Run Command", type: "n8n-nodes-base.executeCommand" },
      { name: "Code", type: "n8n-nodes-base.code" },
    ]);
    const violations = bannedNodeRule.check(wf, "", {
      nodes: [
        { type: "n8n-nodes-base.executeCommand", reason: "Dangerous" },
        { type: "n8n-nodes-base.code", reason: "Use HTTP instead" },
      ],
    });
    expect(violations.length).toBe(2);
  });

  test("duplicate nodes of same banned type each produce a violation", () => {
    const wf = makeWorkflow([
      { name: "Code 1", type: "n8n-nodes-base.code" },
      { name: "Code 2", type: "n8n-nodes-base.code" },
    ]);
    const violations = bannedNodeRule.check(wf, "", {
      nodes: [{ type: "n8n-nodes-base.code" }],
    });
    expect(violations.length).toBe(2);
    expect(violations[0]!.message).toContain("Code 1");
    expect(violations[1]!.message).toContain("Code 2");
  });
});
