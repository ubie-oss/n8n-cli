import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { nodeParamsRule } from "@/lint/rules/node-params.ts";
import { lookupSchemas } from "@/lint/rules/node-params-schema.ts";

/**
 * Integration tests for node-params rule with auto-generated schemas.
 *
 * These tests exercise the full pipeline:
 *   generated JSON → schema index → lookupSchemas → node-params rule
 *
 * They cover nodes that are NOT in the param schema overrides, so they
 * validate that the auto-generated schemas produce correct lint violations.
 *
 * If an n8n package update changes node definitions, some of these tests
 * may need updating — this is intentional for safety.
 */

function makeWorkflow(nodes: Workflow["nodes"]): Workflow {
  return { name: "Test", active: false, nodes, connections: {} };
}

// ---------------------------------------------------------------------------
// Schema lookup tests (unit level)
// ---------------------------------------------------------------------------

describe("lookupSchemas for auto-generated nodes", () => {
  test("returns schemas for telegram v1", () => {
    const schemas = lookupSchemas("n8n-nodes-base.telegram", 1);
    expect(schemas.length).toBeGreaterThan(0);
  });

  test("returns schemas for github v1", () => {
    const schemas = lookupSchemas("n8n-nodes-base.github", 1);
    expect(schemas.length).toBeGreaterThan(0);
  });

  test("returns schemas for todoist v2", () => {
    const schemas = lookupSchemas("n8n-nodes-base.todoist", 2);
    expect(schemas.length).toBeGreaterThan(0);
  });

  test("returns schemas for discord v2", () => {
    const schemas = lookupSchemas("n8n-nodes-base.discord", 2);
    expect(schemas.length).toBeGreaterThan(0);
  });

  test("returns empty for completely unknown node type", () => {
    const schemas = lookupSchemas("n8n-nodes-base.doesNotExist9999", 1);
    expect(schemas.length).toBe(0);
  });

  test("version filtering works — discord v1 vs v2 have different schemas", () => {
    const v1 = lookupSchemas("n8n-nodes-base.discord", 1);
    const v2 = lookupSchemas("n8n-nodes-base.discord", 2);

    // v1 (webhook mode) does not require credentials
    const v1Uncond = v1.find((s) => !s.conditionParam);
    expect(v1Uncond).toBeDefined();
    expect(v1Uncond!.requiresCredentials).toBeUndefined();

    // v2 (bot mode) requires credentials
    const v2Uncond = v2.find((s) => !s.conditionParam);
    expect(v2Uncond).toBeDefined();
    expect(v2Uncond!.requiresCredentials).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Override nodes (existing behavior preserved)
// ---------------------------------------------------------------------------

describe("override node schemas", () => {
  test("code node schemas come from override, not generated", () => {
    const schemas = lookupSchemas("n8n-nodes-base.code", 1);
    // The override has no version range, so it matches all versions
    const uncond = schemas.find((s) => !s.conditionParam);
    expect(uncond).toBeDefined();
    // Override defines jsCode as required
    expect(uncond!.params?.jsCode?.required).toBe(true);
    // Override does NOT include the mode param (which generated would have)
    expect(uncond!.params?.mode).toBeUndefined();
  });

  test("httpRequest schemas come from override", () => {
    const schemas = lookupSchemas("n8n-nodes-base.httpRequest", 1);
    const uncond = schemas.find((s) => !s.conditionParam);
    expect(uncond).toBeDefined();
    // Override defines url as required, method with allowed values
    expect(uncond!.params?.url?.required).toBe(true);
    expect(uncond!.params?.method?.allowedValues).toContain("GET");
  });

  test("slack schemas come from override with conditions", () => {
    const schemas = lookupSchemas("n8n-nodes-base.slack", 1);
    // Override has two entries: default (resource="") and file mode
    expect(schemas.length).toBe(2);
    const defaultMode = schemas.find(
      (s) => s.conditionParam === "resource" && s.conditionValue === "",
    );
    const fileMode = schemas.find(
      (s) => s.conditionParam === "resource" && s.conditionValue === "file",
    );
    expect(defaultMode).toBeDefined();
    expect(fileMode).toBeDefined();
    expect(defaultMode!.params?.channelId?.required).toBe(true);
    expect(fileMode!.params).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.telegram — integration via nodeParamsRule
// ---------------------------------------------------------------------------

describe("node-params rule: telegram", () => {
  test("telegram with credentials and chatId — no credential violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Telegram",
        type: "n8n-nodes-base.telegram",
        typeVersion: 1,
        position: [0, 0],
        parameters: { chatId: "12345", text: "hello", resource: "message" },
        credentials: { telegramApi: { id: "1", name: "Telegram" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(false);
  });

  test("telegram missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Telegram",
        type: "n8n-nodes-base.telegram",
        typeVersion: 1,
        position: [0, 0],
        parameters: { chatId: "12345", text: "hello", resource: "message" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("telegram missing chatId — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Telegram",
        type: "n8n-nodes-base.telegram",
        typeVersion: 1,
        position: [0, 0],
        parameters: { text: "hello", resource: "message" },
        credentials: { telegramApi: { id: "1", name: "Telegram" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("chatId"))).toBe(true);
  });

  test("telegram missing text — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Telegram",
        type: "n8n-nodes-base.telegram",
        typeVersion: 1,
        position: [0, 0],
        parameters: { chatId: "12345", resource: "message" },
        credentials: { telegramApi: { id: "1", name: "Telegram" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("text"))).toBe(true);
  });

  test("telegram with invalid resource enum — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Telegram",
        type: "n8n-nodes-base.telegram",
        typeVersion: 1,
        position: [0, 0],
        parameters: { chatId: "12345", text: "hello", resource: "invalidResource" },
        credentials: { telegramApi: { id: "1", name: "Telegram" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("resource") && v.message.includes("allowed")),
    ).toBe(true);
  });

  test("telegram resource as expression — no enum violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Telegram",
        type: "n8n-nodes-base.telegram",
        typeVersion: 1,
        position: [0, 0],
        parameters: { chatId: "12345", text: "hello", resource: "={{ $json.resource }}" },
        credentials: { telegramApi: { id: "1", name: "Telegram" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("resource") && v.message.includes("allowed")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.github — resourceLocator (nestedRequired)
// ---------------------------------------------------------------------------

describe("node-params rule: github", () => {
  test("github with owner and repository as resourceLocator — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "GitHub",
        type: "n8n-nodes-base.github",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          owner: { value: "my-org", mode: "list" },
          repository: { value: "my-repo", mode: "list" },
          resource: "issue",
        },
        credentials: { githubApi: { id: "1", name: "GitHub" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) =>
          v.message.includes("owner") &&
          (v.message.includes("missing") || v.message.includes("nested")),
      ),
    ).toBe(false);
    expect(
      violations.some(
        (v) =>
          v.message.includes("repository") &&
          (v.message.includes("missing") || v.message.includes("nested")),
      ),
    ).toBe(false);
  });

  test("github owner missing nested value — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "GitHub",
        type: "n8n-nodes-base.github",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          owner: { mode: "list" }, // missing "value"
          repository: { value: "my-repo" },
          resource: "issue",
        },
        credentials: { githubApi: { id: "1", name: "GitHub" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) =>
          v.message.includes("owner") &&
          v.message.includes("nested key") &&
          v.message.includes("value"),
      ),
    ).toBe(true);
  });

  test("github repository nested value is empty — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "GitHub",
        type: "n8n-nodes-base.github",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          owner: { value: "my-org" },
          repository: { value: "" }, // empty nested "value"
          resource: "issue",
        },
        credentials: { githubApi: { id: "1", name: "GitHub" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) =>
          v.message.includes("repository") &&
          v.message.includes("empty") &&
          v.message.includes("nested"),
      ),
    ).toBe(true);
  });

  test("github missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "GitHub",
        type: "n8n-nodes-base.github",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          owner: { value: "my-org" },
          repository: { value: "my-repo" },
          resource: "issue",
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("github invalid resource enum — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "GitHub",
        type: "n8n-nodes-base.github",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          owner: { value: "my-org" },
          repository: { value: "my-repo" },
          resource: "unknown_resource",
        },
        credentials: { githubApi: { id: "1", name: "GitHub" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("resource") && v.message.includes("allowed")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.discord — multi-version behavior
// ---------------------------------------------------------------------------

describe("node-params rule: discord", () => {
  test("discord v2 missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Discord",
        type: "n8n-nodes-base.discord",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          guildId: { value: "123" },
          channelId: { value: "456" },
          message: "hello",
          resource: "message",
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("discord v2 with credentials — no credential violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Discord",
        type: "n8n-nodes-base.discord",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          guildId: { value: "123" },
          channelId: { value: "456" },
          message: "hello",
          resource: "message",
        },
        credentials: { discordBotApi: { id: "1", name: "Discord" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(false);
  });

  test("discord v2 guildId missing nested value — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Discord",
        type: "n8n-nodes-base.discord",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          guildId: { mode: "list" }, // missing "value"
          channelId: { value: "456" },
          message: "hello",
          resource: "message",
        },
        credentials: { discordBotApi: { id: "1", name: "Discord" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("guildId") && v.message.includes("nested key")),
    ).toBe(true);
  });

  test("discord v1 missing webhookUri — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Discord",
        type: "n8n-nodes-base.discord",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) => v.message.includes("webhookUri") && v.message.includes("missing required"),
      ),
    ).toBe(true);
  });

  test("discord v1 with webhookUri — no violation for webhookUri", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Discord",
        type: "n8n-nodes-base.discord",
        typeVersion: 1,
        position: [0, 0],
        parameters: { webhookUri: "https://discord.com/api/webhooks/123/abc" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("webhookUri"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.todoist — credentials, required, resourceLocator
// ---------------------------------------------------------------------------

describe("node-params rule: todoist", () => {
  test("todoist v2 missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Todoist",
        type: "n8n-nodes-base.todoist",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          resource: "task",
          project: { value: "proj-1" },
          content: "My task",
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("todoist v2 project missing nested value — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Todoist",
        type: "n8n-nodes-base.todoist",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          resource: "task",
          project: { mode: "list" }, // missing "value"
          content: "My task",
        },
        credentials: { todoistApi: { id: "1", name: "Todoist" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("project") && v.message.includes("nested key")),
    ).toBe(true);
  });

  test("todoist v2 invalid resource enum — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Todoist",
        type: "n8n-nodes-base.todoist",
        typeVersion: 2,
        position: [0, 0],
        parameters: {
          resource: "nonexistent",
          project: { value: "proj-1" },
          content: "My task",
        },
        credentials: { todoistApi: { id: "1", name: "Todoist" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("resource") && v.message.includes("allowed")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// @n8n/n8n-nodes-langchain.lmChatGoogleVertex — override node
// ---------------------------------------------------------------------------

describe("node-params rule: lmChatGoogleVertex", () => {
  test("missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Google Vertex",
        type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          modelName: "gemini-pro",
          projectId: { value: "my-project" },
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("missing modelName — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Google Vertex",
        type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          projectId: { value: "my-project" },
        },
        credentials: { googleApi: { id: "1", name: "Google" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) => v.message.includes("modelName") && v.message.includes("missing required"),
      ),
    ).toBe(true);
  });

  test("projectId missing nested value — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Google Vertex",
        type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          modelName: "gemini-pro",
          projectId: { mode: "list" },
        },
        credentials: { googleApi: { id: "1", name: "Google" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("projectId") && v.message.includes("nested key")),
    ).toBe(true);
  });

  test("all params valid — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Google Vertex",
        type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          modelName: "gemini-pro",
          projectId: { value: "my-project" },
        },
        credentials: { googleApi: { id: "1", name: "Google" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// @n8n/n8n-nodes-langchain.outputParserStructured — override
// ---------------------------------------------------------------------------

describe("node-params rule: outputParserStructured", () => {
  test("missing inputSchema — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Parser",
        type: "@n8n/n8n-nodes-langchain.outputParserStructured",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) => v.message.includes("inputSchema") && v.message.includes("missing required"),
      ),
    ).toBe(true);
  });

  test("empty inputSchema — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Parser",
        type: "@n8n/n8n-nodes-langchain.outputParserStructured",
        typeVersion: 1,
        position: [0, 0],
        parameters: { inputSchema: "" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("inputSchema") && v.message.includes("empty")),
    ).toBe(true);
  });

  test("valid inputSchema — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Parser",
        type: "@n8n/n8n-nodes-langchain.outputParserStructured",
        typeVersion: 1,
        position: [0, 0],
        parameters: { inputSchema: '{ "type": "object" }' },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.googleBigQuery — override node, credentials + resourceLocator
// ---------------------------------------------------------------------------

describe("node-params rule: googleBigQuery", () => {
  test("missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "BigQuery",
        type: "n8n-nodes-base.googleBigQuery",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          projectId: { value: "my-project" },
        },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("projectId missing nested value — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "BigQuery",
        type: "n8n-nodes-base.googleBigQuery",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          projectId: { mode: "id" },
        },
        credentials: { googleBigQueryApi: { id: "1", name: "BigQuery" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("projectId") && v.message.includes("nested key")),
    ).toBe(true);
  });

  test("valid params — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "BigQuery",
        type: "n8n-nodes-base.googleBigQuery",
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          projectId: { value: "my-project" },
        },
        credentials: { googleBigQueryApi: { id: "1", name: "BigQuery" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.webhook — override, path + httpMethod enum
// ---------------------------------------------------------------------------

describe("node-params rule: webhook", () => {
  test("missing path — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [0, 0],
        parameters: { httpMethod: "POST" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("path") && v.message.includes("missing required")),
    ).toBe(true);
  });

  test("invalid httpMethod — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [0, 0],
        parameters: { path: "/hook", httpMethod: "INVALID" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("httpMethod") && v.message.includes("allowed")),
    ).toBe(true);
  });

  test("valid path and httpMethod — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [0, 0],
        parameters: { path: "/hook", httpMethod: "POST" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.scheduleTrigger — override, required rule object
// ---------------------------------------------------------------------------

describe("node-params rule: scheduleTrigger", () => {
  test("missing rule — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some((v) => v.message.includes("rule") && v.message.includes("missing required")),
    ).toBe(true);
  });

  test("empty rule object — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: { rule: {} },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("rule") && v.message.includes("empty"))).toBe(
      true,
    );
  });

  test("valid rule — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.notion — override, credentials + required resource
// ---------------------------------------------------------------------------

describe("node-params rule: notion", () => {
  test("missing credentials — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Notion",
        type: "n8n-nodes-base.notion",
        typeVersion: 1,
        position: [0, 0],
        parameters: { resource: "page" },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.some((v) => v.message.includes("credentials"))).toBe(true);
  });

  test("missing resource — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Notion",
        type: "n8n-nodes-base.notion",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
        credentials: { notionApi: { id: "1", name: "Notion" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) => v.message.includes("resource") && v.message.includes("missing required"),
      ),
    ).toBe(true);
  });

  test("valid — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Notion",
        type: "n8n-nodes-base.notion",
        typeVersion: 1,
        position: [0, 0],
        parameters: { resource: "page" },
        credentials: { notionApi: { id: "1", name: "Notion" } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// n8n-nodes-base.filter & n8n-nodes-base.if — required conditions
// ---------------------------------------------------------------------------

describe("node-params rule: filter and if", () => {
  test("filter missing conditions — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Filter",
        type: "n8n-nodes-base.filter",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) => v.message.includes("conditions") && v.message.includes("missing required"),
      ),
    ).toBe(true);
  });

  test("if missing conditions — violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "IF",
        type: "n8n-nodes-base.if",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(
      violations.some(
        (v) => v.message.includes("conditions") && v.message.includes("missing required"),
      ),
    ).toBe(true);
  });

  test("filter with conditions — no violation", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Filter",
        type: "n8n-nodes-base.filter",
        typeVersion: 1,
        position: [0, 0],
        parameters: { conditions: { rules: [{ leftValue: "a", rightValue: "b" }] } },
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple nodes in single workflow
// ---------------------------------------------------------------------------

describe("node-params rule: multi-node workflow", () => {
  test("workflow with mixed valid and invalid nodes — correct violation count", () => {
    const wf = makeWorkflow([
      {
        id: "1",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: { rule: { interval: [{ field: "hours" }] } }, // valid
      },
      {
        id: "2",
        name: "HTTP Request",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4,
        position: [200, 0],
        parameters: { method: "GET" }, // missing url
      },
      {
        id: "3",
        name: "Code",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [400, 0],
        parameters: { jsCode: "return [];" }, // valid
      },
      {
        id: "4",
        name: "Slack",
        type: "n8n-nodes-base.slack",
        typeVersion: 1,
        position: [600, 0],
        parameters: {}, // missing credentials, missing channelId
      },
    ]);
    const violations = nodeParamsRule.check(wf, "");
    // HTTP Request: missing url
    expect(
      violations.some((v) => v.message.includes("HTTP Request") && v.message.includes("url")),
    ).toBe(true);
    // Slack: missing credentials
    expect(
      violations.some((v) => v.message.includes("Slack") && v.message.includes("credentials")),
    ).toBe(true);
    // Slack: missing channelId (default resource="" mode)
    expect(
      violations.some((v) => v.message.includes("Slack") && v.message.includes("channelId")),
    ).toBe(true);
    // Schedule and Code should not have violations
    expect(violations.some((v) => v.message.includes("Schedule"))).toBe(false);
    expect(violations.some((v) => v.message.includes("Code"))).toBe(false);
  });
});
