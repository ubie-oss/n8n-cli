import { describe, expect, it } from "bun:test";
import type { Node, Workflow } from "../../src/api/types.ts";
import {
  buildWebhookURL,
  listWebhookNodes,
  resolveWebhookNode,
  WebhookNodeNotFoundError,
} from "../../src/webhook/resolver.ts";

function webhookNode(overrides: Partial<Node> = {}, params: Record<string, unknown> = {}): Node {
  return {
    id: "node-1",
    name: "Manual entry",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2.1,
    position: [0, 0],
    webhookId: "abc",
    parameters: { httpMethod: "POST", path: "hooks/abc", ...params },
    ...overrides,
  };
}

function makeWorkflow(nodes: Node[], overrides: Partial<Workflow> = {}): Workflow {
  return { id: "wf-1", name: "Nightly sync", active: true, nodes, connections: {}, ...overrides };
}

describe("resolveWebhookNode", () => {
  it("resolves a node addressed by its exact name", () => {
    const resolved = resolveWebhookNode(makeWorkflow([webhookNode()]), "Manual entry");
    expect(resolved.path).toBe("hooks/abc");
    expect(resolved.httpMethod).toBe("POST");
  });

  it("defaults the method to POST when the node does not set one", () => {
    const node = webhookNode();
    delete (node.parameters as Record<string, unknown>).httpMethod;
    expect(resolveWebhookNode(makeWorkflow([node]), "Manual entry").httpMethod).toBe("POST");
  });

  it("upper-cases a lower-case method", () => {
    const resolved = resolveWebhookNode(
      makeWorkflow([webhookNode({}, { httpMethod: "get" })]),
      "Manual entry",
    );
    expect(resolved.httpMethod).toBe("GET");
  });

  it("falls back to the node id when the node has no path", () => {
    const node = webhookNode();
    delete (node.parameters as Record<string, unknown>).path;
    expect(resolveWebhookNode(makeWorkflow([node]), "Manual entry").path).toBe("node-1");
  });

  it("never guesses: an unmatched name is an error even with exactly one webhook", () => {
    expect(() => resolveWebhookNode(makeWorkflow([webhookNode()]), "Other")).toThrow(
      WebhookNodeNotFoundError,
    );
  });

  it("matches names exactly, not by prefix", () => {
    expect(() => resolveWebhookNode(makeWorkflow([webhookNode()]), "Manual")).toThrow(
      WebhookNodeNotFoundError,
    );
  });

  it("refuses a node of another type that happens to share the name", () => {
    const workflow = makeWorkflow([webhookNode({ type: "n8n-nodes-base.formTrigger" })]);
    expect(() => resolveWebhookNode(workflow, "Manual entry")).toThrow(/expected/);
  });

  it("refuses a disabled node, whose webhook n8n never registered", () => {
    const workflow = makeWorkflow([webhookNode({ disabled: true })]);
    expect(() => resolveWebhookNode(workflow, "Manual entry")).toThrow(/disabled/);
  });

  it("picks the named node out of several webhooks", () => {
    const workflow = makeWorkflow([
      webhookNode(),
      webhookNode({ id: "node-2", name: "Partner callback" }, { path: "hooks/partner" }),
    ]);
    expect(resolveWebhookNode(workflow, "Partner callback").path).toBe("hooks/partner");
  });

  it("rejects a null workflow", () => {
    expect(() => resolveWebhookNode(null, "x")).toThrow("workflow is nil");
  });
});

describe("listWebhookNodes", () => {
  it("lists enabled webhook nodes only", () => {
    const workflow = makeWorkflow([
      webhookNode(),
      webhookNode({ id: "n2", name: "Disabled one", disabled: true }),
      webhookNode({ id: "n3", name: "A form", type: "n8n-nodes-base.formTrigger" }),
      { id: "n4", name: "Set", type: "n8n-nodes-base.set", typeVersion: 1, position: [0, 0] },
    ]);
    expect(listWebhookNodes(workflow).map((w) => w.node.name)).toEqual(["Manual entry"]);
  });

  it("returns nothing for a workflow with no nodes array", () => {
    expect(
      listWebhookNodes({ id: "x", name: "e", active: true, connections: {} } as Workflow),
    ).toEqual([]);
  });

  it("returns nothing for a null workflow", () => {
    expect(listWebhookNodes(null)).toEqual([]);
  });
});

describe("buildWebhookURL", () => {
  it("appends the path to a bare base URL", () => {
    expect(buildWebhookURL("https://gw.example.com", "hooks/abc")).toBe(
      "https://gw.example.com/webhook/hooks/abc",
    );
  });

  it("strips a trailing /api/v1 and slashes", () => {
    expect(buildWebhookURL("https://gw.example.com/api/v1/", "/hooks/abc")).toBe(
      "https://gw.example.com/webhook/hooks/abc",
    );
  });
});
