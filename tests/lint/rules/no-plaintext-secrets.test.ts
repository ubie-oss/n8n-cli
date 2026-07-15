import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { isSensitiveName, noPlaintextSecretsRule } from "@/lint/rules/no-plaintext-secrets.ts";

function makeWorkflow(
  nodes: Array<{ name: string; type: string; parameters?: Record<string, unknown> }>,
): Workflow {
  return {
    name: "Test",
    active: true,
    nodes: nodes.map((n, i) => ({
      id: String(i + 1),
      name: n.name,
      type: n.type,
      typeVersion: 1,
      position: [0, 0] as [number, number],
      parameters: n.parameters,
    })),
    connections: {},
  };
}

function httpRequestWorkflow(parameters: Record<string, unknown>): Workflow {
  return makeWorkflow([{ name: "HTTP", type: "n8n-nodes-base.httpRequest", parameters }]);
}

describe("no-plaintext-secrets rule", () => {
  test("name is no-plaintext-secrets", () => {
    expect(noPlaintextSecretsRule.name).toBe("no-plaintext-secrets");
  });

  test("default severity is error", () => {
    expect(noPlaintextSecretsRule.defaultSeverity).toBe("error");
  });

  test("null workflow returns empty array", () => {
    expect(noPlaintextSecretsRule.check(null, "")).toEqual([]);
  });

  test("workflow without parameters returns no violations", () => {
    const wf = makeWorkflow([{ name: "Start", type: "n8n-nodes-base.manualTrigger" }]);
    expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
  });

  describe("layer 1: schema-declared password params", () => {
    test("detects literal in a password-masked param (crypto.secret)", () => {
      const wf = makeWorkflow([
        {
          name: "Crypto",
          type: "n8n-nodes-base.crypto",
          parameters: { action: "hmac", secret: "hmacSigningKey123" },
        },
      ]);
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain("password-masked field");
      expect(violations[0]!.message).toContain('"parameters.secret"');
    });

    test("allows expression in a password-masked param", () => {
      const wf = makeWorkflow([
        {
          name: "Crypto",
          type: "n8n-nodes-base.crypto",
          parameters: { action: "hmac", secret: "={{ $env.HMAC_SECRET }}" },
        },
      ]);
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("never echoes the full secret in the message", () => {
      const secret = "hmacSigningKey123SuperSecret";
      const wf = makeWorkflow([
        {
          name: "Crypto",
          type: "n8n-nodes-base.crypto",
          parameters: { action: "hmac", secret },
        },
      ]);
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).not.toContain(secret);
    });
  });

  describe("layer 2: sensitive names in header/query collections", () => {
    test("detects Authorization header with literal token", () => {
      const wf = httpRequestWorkflow({
        url: "https://api.example.com",
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: "Authorization", value: "Bearer abc123DEF456ghi789" }],
        },
      });
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain('"Authorization"');
      expect(violations[0]!.message).not.toContain("abc123DEF456ghi789");
    });

    test("allows Authorization header built from an expression", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [{ name: "Authorization", value: "=Bearer {{ $env.API_TOKEN }}" }],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("detects X-API-Key header with literal", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [{ name: "X-API-Key", value: "9f8e7d6c5b4a3210" }],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "").length).toBe(1);
    });

    test("ignores non-sensitive headers", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [
            { name: "Content-Type", value: "application/json" },
            { name: "Accept", value: "application/json" },
          ],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("ignores placeholder values", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [
            { name: "Authorization", value: "Bearer YOUR_API_KEY_HERE" },
            { name: "X-API-Key", value: "<api-key>" },
          ],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("ignores short values", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [{ name: "X-API-Key", value: "abc12" }],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("detects sensitive query parameter in collection", () => {
      const wf = httpRequestWorkflow({
        sendQuery: true,
        queryParameters: {
          parameters: [{ name: "api_key", value: "qwerty123456UIOP" }],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "").length).toBe(1);
    });

    test("detects sensitive assignment in Set node", () => {
      const wf = makeWorkflow([
        {
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            assignments: {
              assignments: [
                { id: "1", name: "slackToken", value: "tokenValue123456", type: "string" },
              ],
            },
          },
        },
      ]);
      expect(noPlaintextSecretsRule.check(wf, "").length).toBe(1);
    });

    test("detects sensitive plain object key", () => {
      const wf = makeWorkflow([
        {
          name: "Custom",
          type: "n8n-nodes-base.someNode",
          parameters: { clientSecret: "sup3rSecretValue99" },
        },
      ]);
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain('"parameters.clientSecret"');
    });

    test("metadata-suffixed keys are not sensitive", () => {
      const wf = makeWorkflow([
        {
          name: "Custom",
          type: "n8n-nodes-base.someNode",
          parameters: {
            tokenType: "RefreshTokenRotation1",
            apiKeyName: "X-Custom-Api-Key1",
            nodeCredentialType: "httpHeaderAuth1",
          },
        },
      ]);
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });
  });

  describe("layer 2: embedded JSON, URLs", () => {
    test("detects secret in jsonHeaders JSON string", () => {
      const wf = httpRequestWorkflow({
        specifyHeaders: "json",
        jsonHeaders: '{"Authorization": "Bearer abc123DEF456ghi789"}',
      });
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain('"Authorization"');
    });

    test("allows jsonHeaders with expression values", () => {
      const wf = httpRequestWorkflow({
        specifyHeaders: "json",
        jsonHeaders: '={"Authorization": "Bearer {{ $env.TOKEN }}"}',
      });
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("detects sensitive query parameter in URL", () => {
      const wf = httpRequestWorkflow({
        url: "https://api.example.com/v1?api_key=qwerty123456UIOP",
      });
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain('"api_key"');
    });

    test("allows URL query parameter with expression", () => {
      const wf = httpRequestWorkflow({
        url: "=https://api.example.com/v1?api_key={{ $env.API_KEY }}",
      });
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });

    test("detects password embedded in URL userinfo", () => {
      const wf = httpRequestWorkflow({
        url: "https://admin:S3cretPass99@internal.example.com/",
      });
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain("embeds a password in a URL");
      expect(violations[0]!.message).not.toContain("S3cretPass99");
    });
  });

  describe("layer 3: known token formats", () => {
    // Token fixtures are assembled at runtime by concatenation so the source
    // file contains no contiguous secret-shaped literal that would trip
    // GitHub push-protection / secret-scanning (the strings are all fake).
    const cases: Array<[string, string]> = [
      ["aws-access-key-id", "AKIAIOSFODNN7EXAMPLE"],
      ["github-token", `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`],
      ["slack-token", `xox${"b"}-1234567890-abcdefghijklmn`],
      ["anthropic-api-key", `sk-${"ant"}-api03-abcdefghijklmnopqrstuvwx`],
      ["google-api-key", `AIza${"Sy"}A1234567890abcdefghijklmnopqrstuv`],
      ["stripe-key", `sk_${"live"}_a1B2c3D4e5F6g7H8i9J0`],
      ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
    ];

    for (const [id, token] of cases) {
      test(`detects ${id} in Code node source`, () => {
        const wf = makeWorkflow([
          {
            name: "Code",
            type: "n8n-nodes-base.code",
            parameters: { jsCode: `const v = "${token}"; return items;` },
          },
        ]);
        const violations = noPlaintextSecretsRule.check(wf, "");
        expect(violations.length).toBeGreaterThanOrEqual(1);
        expect(violations.some((v) => v.message.includes(id))).toBe(true);
      });
    }

    test("detects token pasted into a sticky note", () => {
      const wf = makeWorkflow([
        {
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          parameters: { content: "old key: AKIAIOSFODNN7EXAMPLE" },
        },
      ]);
      expect(noPlaintextSecretsRule.check(wf, "").length).toBe(1);
    });

    test("detects token embedded inside an expression literal", () => {
      const wf = httpRequestWorkflow({
        url: `={{ "https://api.example.com?key=" + "AIza${"Sy"}A1234567890abcdefghijklmnopqrstuv" }}`,
      });
      expect(noPlaintextSecretsRule.check(wf, "").length).toBeGreaterThanOrEqual(1);
    });

    test("detects assignment-style hardcoded secret in code", () => {
      const wf = makeWorkflow([
        {
          name: "Code",
          type: "n8n-nodes-base.code",
          parameters: { jsCode: 'const apiKey = "zXcVbNm123456qwe";' },
        },
      ]);
      const violations = noPlaintextSecretsRule.check(wf, "");
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain("hardcoded secret assignment");
    });

    test("does not flag ordinary code without secrets", () => {
      const wf = makeWorkflow([
        {
          name: "Code",
          type: "n8n-nodes-base.code",
          parameters: {
            jsCode: "const items = $input.all();\nreturn items.map((i) => i.json);",
          },
        },
      ]);
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
    });
  });

  describe("options", () => {
    test("allowValues suppresses matching values", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [{ name: "X-API-Key", value: "test-fixture-key-123" }],
        },
      });
      const violations = noPlaintextSecretsRule.check(wf, "", {
        allowValues: ["^test-fixture-"],
      });
      expect(violations).toEqual([]);
    });

    test("additionalNames adds sensitive key names", () => {
      const wf = makeWorkflow([
        {
          name: "Custom",
          type: "n8n-nodes-base.someNode",
          parameters: { signingSeed: "abcDEF123456xyz9" },
        },
      ]);
      expect(noPlaintextSecretsRule.check(wf, "")).toEqual([]);
      const violations = noPlaintextSecretsRule.check(wf, "", {
        additionalNames: ["signingSeed"],
      });
      expect(violations.length).toBe(1);
    });

    test("additionalPatterns adds custom value patterns", () => {
      const wf = makeWorkflow([
        {
          name: "Code",
          type: "n8n-nodes-base.code",
          parameters: { jsCode: 'const k = "ACME-INTERNAL-0123456789";' },
        },
      ]);
      const violations = noPlaintextSecretsRule.check(wf, "", {
        additionalPatterns: ["ACME-INTERNAL-[0-9]{10}"],
      });
      expect(violations.length).toBe(1);
      expect(violations[0]!.message).toContain("custom-pattern-1");
    });

    test("minSecretLength raises the literal length threshold", () => {
      const wf = httpRequestWorkflow({
        headerParameters: {
          parameters: [{ name: "X-API-Key", value: "abc123def4" }],
        },
      });
      expect(noPlaintextSecretsRule.check(wf, "").length).toBe(1);
      expect(noPlaintextSecretsRule.check(wf, "", { minSecretLength: 20 })).toEqual([]);
    });
  });

  describe("isSensitiveName", () => {
    const sensitive = [
      "Authorization",
      "X-API-Key",
      "api_key",
      "apikey",
      "password",
      "clientSecret",
      "accessKey",
      "privateKey",
      "sessionToken",
      "Cookie",
      "Proxy-Authorization",
    ];
    for (const name of sensitive) {
      test(`"${name}" is sensitive`, () => {
        expect(isSensitiveName(name)).toBe(true);
      });
    }

    const notSensitive = [
      "Content-Type",
      "authentication",
      "genericAuthType",
      "nodeCredentialType",
      "maxTokens",
      "tokenType",
      "url",
      "value",
      "name",
    ];
    for (const name of notSensitive) {
      test(`"${name}" is not sensitive`, () => {
        expect(isSensitiveName(name)).toBe(false);
      });
    }
  });

  test("duplicate violations are reported once", () => {
    const wf = httpRequestWorkflow({
      headerParameters: {
        parameters: [{ name: "Authorization", value: "Bearer abc123DEF456ghi789" }],
      },
    });
    const violations = noPlaintextSecretsRule.check(wf, "");
    const messages = violations.map((v) => v.message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
