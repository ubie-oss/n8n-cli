import { describe, expect, test } from "bun:test";
import type { Node, Workflow } from "@/api/types.ts";
import { unauthenticatedWebhookRule } from "@/lint/rules/unauthenticated-webhook.ts";

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2.1,
    position: [0, 0],
    ...overrides,
  };
}

function makeWorkflow(nodes: Node[], overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf1",
    name: "Test",
    active: true,
    nodes,
    connections: {},
    ...overrides,
  };
}

describe("unauthenticated-webhook rule", () => {
  test("null workflow returns no violations", () => {
    expect(unauthenticatedWebhookRule.check(null, "")).toEqual([]);
  });

  test("an authenticated trigger passes", () => {
    const wf = makeWorkflow([
      makeNode({ parameters: { authentication: "headerAuth", path: "a" } }),
    ]);
    expect(unauthenticatedWebhookRule.check(wf, "")).toEqual([]);
  });

  test("with no options an unauthenticated trigger is still denied", () => {
    const wf = makeWorkflow([makeNode({ parameters: { authentication: "none", path: "open" } })]);
    const violations = unauthenticatedWebhookRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]?.severity).toBe("error");
    expect(violations[0]?.message).toContain("without authentication");
    expect(violations[0]?.message).toContain('path "open"');
  });

  test("a missing authentication key is reported as such, not as a choice", () => {
    const wf = makeWorkflow([makeNode({ parameters: { path: "open" } })]);
    const violations = unauthenticatedWebhookRule.check(wf, "");
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("declares no authentication method");
  });

  test("an allowlisted workflow may carry one", () => {
    const wf = makeWorkflow([makeNode({ parameters: { authentication: "none", path: "open" } })]);
    expect(unauthenticatedWebhookRule.check(wf, "", { allowWorkflows: ["wf1"] })).toEqual([]);
  });

  test("a workflow outside the allowlist is denied", () => {
    const wf = makeWorkflow([makeNode({ parameters: { authentication: "none" } })]);
    const violations = unauthenticatedWebhookRule.check(wf, "", { allowWorkflows: ["other"] });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain('add "wf1"');
  });

  test("the allowlist matches ids, not names", () => {
    const wf = makeWorkflow([makeNode({ parameters: { authentication: "none" } })], {
      name: "Public Hook",
    });
    expect(
      unauthenticatedWebhookRule.check(wf, "", { allowWorkflows: ["Public Hook"] }).length,
    ).toBe(1);
  });

  test("a workflow with no id cannot be allowlisted, and is told so", () => {
    const wf = makeWorkflow([makeNode({ parameters: { authentication: "none" } })], {
      id: undefined,
    });
    const violations = unauthenticatedWebhookRule.check(wf, "", { allowWorkflows: ["wf1"] });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("has no id yet");
  });

  test("requireAuthPaths outranks the allowlist", () => {
    const wf = makeWorkflow([
      makeNode({ parameters: { authentication: "none", path: "__cli-test__/abc" } }),
    ]);
    const violations = unauthenticatedWebhookRule.check(wf, "", {
      allowWorkflows: ["wf1"],
      requireAuthPaths: ["__cli-test__/*"],
    });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("reserved for authenticated entry points");
    expect(violations[0]?.message).toContain("Allowlisting the workflow does not cover it");
  });

  test("requireAuthPaths leaves an authenticated reserved path alone", () => {
    const wf = makeWorkflow([
      makeNode({ parameters: { authentication: "headerAuth", path: "__cli-test__/abc" } }),
    ]);
    expect(
      unauthenticatedWebhookRule.check(wf, "", { requireAuthPaths: ["__cli-test__/*"] }),
    ).toEqual([]);
  });

  test("a path outside requireAuthPaths falls back to the allowlist", () => {
    const wf = makeWorkflow([
      makeNode({ parameters: { authentication: "none", path: "slack-events" } }),
    ]);
    expect(
      unauthenticatedWebhookRule.check(wf, "", {
        allowWorkflows: ["wf1"],
        requireAuthPaths: ["__cli-test__/*"],
      }),
    ).toEqual([]);
  });

  test("an expression is refused because it cannot be decided statically", () => {
    const wf = makeWorkflow([
      makeNode({ parameters: { authentication: "={{ $json.mode }}", path: "open" } }),
    ]);
    const violations = unauthenticatedWebhookRule.check(wf, "", { allowWorkflows: ["wf1"] });
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain("from an expression");
  });

  test("a disabled trigger publishes nothing", () => {
    const wf = makeWorkflow([makeNode({ parameters: { authentication: "none" }, disabled: true })]);
    expect(unauthenticatedWebhookRule.check(wf, "")).toEqual([]);
  });

  test("form and chat triggers are covered", () => {
    const wf = makeWorkflow([
      makeNode({ name: "Form", type: "n8n-nodes-base.formTrigger", parameters: {} }),
      makeNode({
        name: "Chat",
        type: "@n8n/n8n-nodes-langchain.chatTrigger",
        parameters: { authentication: "none" },
      }),
    ]);
    const violations = unauthenticatedWebhookRule.check(wf, "");
    expect(violations.length).toBe(2);
  });

  test("triggers without an endpoint are ignored", () => {
    const wf = makeWorkflow([
      makeNode({ name: "Schedule", type: "n8n-nodes-base.scheduleTrigger", parameters: {} }),
      makeNode({ name: "Code", type: "n8n-nodes-base.code", parameters: {} }),
    ]);
    expect(unauthenticatedWebhookRule.check(wf, "")).toEqual([]);
  });
});
