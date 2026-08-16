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

function makeNode(name: string, type: string, parameters?: Record<string, unknown>): Workflow {
  return {
    name: "Test",
    active: true,
    nodes: [
      {
        id: "1",
        name,
        type,
        typeVersion: 1,
        position: [0, 0] as [number, number],
        parameters,
      },
    ],
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

describe("banned-node: deny matchers", () => {
  test("deny by glob pattern", () => {
    const wf = makeWorkflow([{ name: "Exec", type: "n8n-nodes-base.executeCommand" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "n8n-nodes-base.*Command", match: "glob" }],
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('banned type "n8n-nodes-base.executeCommand"');
  });

  test("deny pattern defaults to glob when match omitted", () => {
    const wf = makeWorkflow([{ name: "Exec", type: "n8n-nodes-base.executeCommand" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "n8n-nodes-base.*" }],
    });
    expect(violations.length).toBe(1);
  });

  test("deny by regex pattern", () => {
    const wf = makeWorkflow([{ name: "Code", type: "n8n-nodes-base.code" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "n8n-nodes-base\\.(code|function)", match: "regex" }],
    });
    expect(violations.length).toBe(1);
  });

  test("deny regex does not match a non-matching type", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "n8n-nodes-base\\.(code|function)", match: "regex" }],
    });
    expect(violations.length).toBe(0);
  });

  test("deny with reason on a glob matcher", () => {
    const wf = makeWorkflow([{ name: "SSH", type: "n8n-nodes-base.ssh" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "*.ssh", match: "glob", reason: "No SSH in CI" }],
    });
    expect(violations[0]!.message).toBe(
      'Node "SSH" uses banned type "n8n-nodes-base.ssh": No SSH in CI',
    );
  });

  test("deny wins over allow", () => {
    const wf = makeWorkflow([{ name: "Slack", type: "n8n-nodes-base.slack" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ type: "n8n-nodes-base.slack", reason: "blocked" }],
      allow: [{ type: "n8n-nodes-base.slack" }],
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("blocked");
  });
});

describe("banned-node: allowlist mode", () => {
  test("node listed in allow passes", () => {
    const wf = makeWorkflow([{ name: "Slack", type: "n8n-nodes-base.slack" }]);
    const violations = bannedNodeRule.check(wf, "", {
      allow: [{ type: "n8n-nodes-base.slack" }],
    });
    expect(violations.length).toBe(0);
  });

  test("node not in allowlist is banned", () => {
    const wf = makeWorkflow([{ name: "Code", type: "n8n-nodes-base.code" }]);
    const violations = bannedNodeRule.check(wf, "", {
      allow: [{ type: "n8n-nodes-base.slack" }],
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("not in the allowlist");
  });

  test("allowlist with glob matches multiple types", () => {
    const wf = makeWorkflow([
      { name: "Slack", type: "n8n-nodes-base.slack" },
      { name: "HTTP", type: "n8n-nodes-base.httpRequest" },
      { name: "Code", type: "n8n-nodes-base.code" },
    ]);
    const violations = bannedNodeRule.check(wf, "", {
      allow: [{ pattern: "n8n-nodes-base.*", match: "glob" }],
    });
    expect(violations.length).toBe(0);
  });

  test("empty allow keeps deny-only behavior", () => {
    const wf = makeWorkflow([{ name: "Slack", type: "n8n-nodes-base.slack" }]);
    const violations = bannedNodeRule.check(wf, "", {
      allow: [],
      deny: [{ type: "n8n-nodes-base.code" }],
    });
    expect(violations.length).toBe(0);
  });
});

describe("banned-node: params policy (allowParams / denyParams)", () => {
  test("allowParams: all listed params pass", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      resource: "message",
      text: "hello",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { allowParams: ["resource", "text"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("allowParams: unlisted param is a violation", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      resource: "message",
      text: "hello",
      extra: "x",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { allowParams: ["resource", "text"] } },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('parameter "extra" is not allowed');
  });

  test("denyParams: listed param present is a violation", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      resource: "message",
      messageType: "chat",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { denyParams: ["messageType"] } },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('parameter "messageType" is not allowed');
  });

  test("denyParams: absent param is fine", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { resource: "message" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { denyParams: ["messageType"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("params keyed by glob node type applies to matching nodes", () => {
    const wf = makeWorkflow([
      { name: "Slack", type: "n8n-nodes-base.slack" },
      { name: "HTTP", type: "n8n-nodes-base.httpRequest" },
    ]);
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.*": { denyParams: ["additionalFields"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("params keyed by regex node type", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { resource: "message" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "/n8n-nodes-base\\.slack/": { denyParams: ["foo"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("params keyed by '*' applies to all nodes", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { resource: "message" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "*": { denyParams: ["resource"] } },
    });
    expect(violations.length).toBe(1);
  });

  test("params policy only applies to the matching node type", () => {
    const wf = makeNode("HTTP", "n8n-nodes-base.httpRequest", { resource: "message" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { denyParams: ["resource"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("empty policy object is ignored", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { resource: "message" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": {} },
    });
    expect(violations.length).toBe(0);
  });

  test("jsCode is exempt from allowParams even when not listed", () => {
    const wf = makeNode("Code", "n8n-nodes-base.code", { jsCode: "return [];" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.code": { allowParams: ["other"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("empty allowParams disables the presence check entirely", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { resource: "message" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { allowParams: [] } },
    });
    expect(violations.length).toBe(0);
  });
});

describe("banned-node: params merge across specificity", () => {
  test("'*' expressions deny overridden by exact node expressions allow", () => {
    const wf = makeWorkflow([
      { name: "Slack", type: "n8n-nodes-base.slack" },
      { name: "HTTP", type: "n8n-nodes-base.httpRequest" },
    ]);
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "*": { expressions: "deny" },
        "n8n-nodes-base.slack": { expressions: "allow" },
      },
    });
    // Slack explicitly allows expressions; HTTP inherits the '*' deny default.
    expect(violations.filter((v) => v.message.includes("Slack"))).toHaveLength(0);
    expect(violations.filter((v) => v.message.includes("HTTP"))).toHaveLength(0);
  });

  test("'*' deny + exact slack value override: only non-overridden paths flagged", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      text: "=dynamic",
      channelId: { value: "=also-dynamic" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "*": { expressions: "deny" },
        "n8n-nodes-base.slack": { values: { text: { expressions: "allow" } } },
      },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('parameter "channelId.value"');
  });

  test("allowParams are unioned across matching entries", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      resource: "message",
      text: "hi",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.*": { allowParams: ["resource"] },
        "n8n-nodes-base.slack": { allowParams: ["text"] },
      },
    });
    expect(violations.length).toBe(0);
  });
});

describe("banned-node: values rules", () => {
  test("exact allow list satisfied passes", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      channelId: { value: "#general" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "channelId.value": { allow: ["#general", "#ops"] } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("value outside allow list is a violation", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      channelId: { value: "#random" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "channelId.value": { allow: ["#general", "#ops"] } },
        },
      },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('parameter "channelId.value"');
    expect(violations[0]!.message).toContain('"#random"');
  });

  test("empty allow list forbids the nested key entirely", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { attachments: "x" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "additionalFields.attachments": { allow: [] } },
        },
      },
    });
    expect(violations.length).toBe(1);
  });

  test("glob path pattern matches nested leaves", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "ok", iconEmoji: ":wave:" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "additionalFields.*": { allow: ["ok", ":wave:"] } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("glob path pattern flags a violating nested leaf", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "ok", iconEmoji: ":x:" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "additionalFields.*": { allow: ["ok", ":wave:"] } },
        },
      },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('"additionalFields.iconEmoji"');
  });

  test("value pattern with glob", () => {
    const wf = makeNode("HTTP", "n8n-nodes-base.httpRequest", { url: "https://example.com/api" });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": {
          values: { url: { pattern: "https://example.com/*", match: "glob" } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("value pattern with glob violation", () => {
    const wf = makeNode("HTTP", "n8n-nodes-base.httpRequest", { url: "http://evil.com" });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": {
          values: { url: { pattern: "https://example.com/*", match: "glob" } },
        },
      },
    });
    expect(violations.length).toBe(1);
  });

  test("value pattern with regex", () => {
    const wf = makeNode("HTTP", "n8n-nodes-base.httpRequest", { url: "https://example.com/api" });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": {
          values: { url: { pattern: "^https://example\\.com/", match: "regex" } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("value pattern with regex violation", () => {
    const wf = makeNode("HTTP", "n8n-nodes-base.httpRequest", { url: "http://evil.com" });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": {
          values: { url: { pattern: "^https://example\\.com/", match: "regex" } },
        },
      },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("does not match pattern /^https://example\\.com//");
  });

  test("most specific path rule wins", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "other", nested: "allowed" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: {
            "additionalFields.*": { allow: ["allowed"] },
            "additionalFields.fallback": { allow: ["specific"] },
          },
        },
      },
    });
    // fallback is governed by the exact rule ("specific"), nested by the glob.
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('"additionalFields.fallback"');
  });

  test("expression value skips literal allow check", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      channelId: { value: "={{ $json.channel }}" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "channelId.value": { allow: ["#general"] } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("non-string values are stringified for allow comparison", () => {
    const wf = makeNode("Split", "n8n-nodes-base.splitInBatches", { batchSize: 3 });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.splitInBatches": {
          values: { batchSize: { allow: ["3", "5"] } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("value rule on a missing path is a no-op", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { text: "hi" });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "channelId.value": { allow: ["#general"] } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("regex path rule selects nested leaves", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "hi", iconEmoji: ":wave:" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: { "/additionalFields\\.(fallback|iconEmoji)/": { allow: ["hi", ":wave:"] } },
        },
      },
    });
    expect(violations.length).toBe(0);
  });

  test("a rule with both allow and pattern reports each violated constraint", () => {
    const wf = makeNode("HTTP", "n8n-nodes-base.httpRequest", { url: "http://evil.com" });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": {
          values: {
            url: { allow: ["https://allowed.example"], pattern: "^https://", match: "regex" },
          },
        },
      },
    });
    expect(violations.length).toBe(2);
  });

  test("allowParams supports glob patterns over the key", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "hi" },
      resource: "message",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { allowParams: ["additional*", "resource"] } },
    });
    expect(violations.length).toBe(0);
  });

  test("broad expressions deny still applies under a narrower allow rule", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "={{ $json.x }}" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: {
            "additionalFields.*": { expressions: "deny" },
            "additionalFields.fallback": { allow: ["hi"] },
          },
        },
      },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("expressions are not allowed");
  });

  test("broad allow still applies under a narrower expressions rule", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { fallback: "other" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          values: {
            "additionalFields.*": { allow: ["hi"] },
            "additionalFields.fallback": { expressions: "deny" },
          },
        },
      },
    });
    // "other" fails the broad allow; it is not an expression, so the specific
    // expressions rule is silent.
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('"additionalFields.fallback"');
    expect(violations[0]!.message).toContain('"other"');
  });
});

describe("banned-node: expressions policy", () => {
  test("default allow permits expressions", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { text: "={{ $json.field }}" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": {} },
    });
    expect(violations.length).toBe(0);
  });

  test("node expressions deny flags '=' expressions", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { text: "={{ $json.field }}" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { expressions: "deny" } },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('parameter "text"');
  });

  test("node expressions deny flags bare {{ }} expressions", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", { text: "Hello {{ $json.name }}" });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { expressions: "deny" } },
    });
    expect(violations.length).toBe(1);
  });

  test("node expressions deny with path-level allow override", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      text: "={{ $json.field }}",
      channelId: { value: "=dynamic" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          expressions: "deny",
          values: { text: { expressions: "allow" } },
        },
      },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('"channelId.value"');
  });

  test("node expressions deny with path-level deny override", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      text: "={{ $json.field }}",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          expressions: "allow",
          values: { text: { expressions: "deny" } },
        },
      },
    });
    expect(violations.length).toBe(1);
  });

  test("code parameters are exempt from expression checks", () => {
    const wf = makeNode("Code", "n8n-nodes-base.code", {
      jsCode: "const x = {{ 1 + 1 }}; return [x];",
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.code": { expressions: "deny" } },
    });
    expect(violations.length).toBe(0);
  });

  test("nested expression values are detected", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      additionalFields: { iconEmoji: "={{ $json.emoji }}" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: { "n8n-nodes-base.slack": { expressions: "deny" } },
    });
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain('"additionalFields.iconEmoji"');
  });
});

describe("banned-node: config validation", () => {
  test("invalid regex in params key produces an error violation", () => {
    const wf = makeWorkflow([{ name: "Slack", type: "n8n-nodes-base.slack" }]);
    const violations = bannedNodeRule.check(wf, "", {
      params: { "/[/": { denyParams: ["resource"] } },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe("error");
    expect(violations[0]!.message).toContain("Invalid regex");
  });

  test("invalid regex in value pattern produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": { values: { url: { pattern: "(", match: "regex" } } },
      },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe("error");
  });

  test("invalid regex in deny matcher produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "(", match: "regex" }],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe("error");
  });

  test("invalid match value produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ pattern: "x", match: "fuzzy" }],
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe("error");
  });

  test("invalid matcher (neither type nor pattern) produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ reason: "no type" }],
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  test("matcher with both type and pattern produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: [{ type: "n8n-nodes-base.httpRequest", pattern: "http*" }],
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  test("deny entries that are not objects produce error violations", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      deny: ["n8n-nodes-base.httpRequest"],
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  test("params not an object produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      params: "nope",
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  test("allow not an array produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      allow: "nope",
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  test("invalid expressions value produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      params: { "*": { expressions: "sometimes" } },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe("error");
  });

  test("value rule with match but no pattern produces an error violation", () => {
    const wf = makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest" }]);
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.httpRequest": { values: { url: { match: "regex" } } },
      },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.severity).toBe("error");
  });

  test("valid config with params does not emit config errors", () => {
    const wf = makeNode("Slack", "n8n-nodes-base.slack", {
      channelId: { value: "#general" },
    });
    const violations = bannedNodeRule.check(wf, "", {
      params: {
        "n8n-nodes-base.slack": {
          allowParams: ["channelId"],
          values: { "channelId.value": { allow: ["#general"] } },
        },
      },
    });
    expect(violations).toEqual([]);
  });
});
