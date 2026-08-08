import { describe, expect, test } from "bun:test";
import {
  resolveWebhookTokenRules,
  webhookTokenInjectFactory,
  webhookTokenInjectOptionsSchema,
} from "@/middleware/builtin/webhook-token-inject/factory.ts";
import { WebhookTokenInjectMiddleware } from "@/middleware/builtin/webhook-token-inject/middleware.ts";

function ctx(pathname: string) {
  return {
    request: new Request(`http://proxy.local${pathname}`),
    method: "POST",
    pathname,
    upstreamUrl: `http://upstream.local${pathname}`,
  };
}

const agentRule = {
  pathPrefix: "/webhook/agent/",
  header: "x-agent-token",
  token: "agent-secret",
  conflictPolicy: "set-if-absent" as const,
};

const testRule = {
  pathPrefix: "/webhook/cli-test/",
  header: "x-cli-test-token",
  token: "cli-test-secret",
  conflictPolicy: "set-if-absent" as const,
};

describe("WebhookTokenInjectMiddleware ownedHeaders", () => {
  test("a replace rule claims its header, so a second writer is detectable", () => {
    const mw = new WebhookTokenInjectMiddleware({
      rules: [{ ...agentRule, header: "Authorization", conflictPolicy: "replace" }],
    });
    expect(mw.ownedHeaders).toEqual(["authorization"]);
  });

  test("a set-if-absent rule claims nothing — it defers to the caller by design", () => {
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule, testRule] });
    expect(mw.ownedHeaders).toEqual([]);
  });

  test("two replace rules on one header claim it once", () => {
    const mw = new WebhookTokenInjectMiddleware({
      rules: [
        { ...agentRule, conflictPolicy: "replace" },
        { ...agentRule, pathPrefix: "/webhook/agent/sub/", conflictPolicy: "replace" },
      ],
    });
    expect(mw.ownedHeaders).toEqual(["x-agent-token"]);
  });
});

describe("WebhookTokenInjectMiddleware", () => {
  test("injects the token on a path under the rule's prefix", () => {
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/webhook/agent/abc-123"));
    expect(headers.get("x-agent-token")).toBe("agent-secret");
  });

  test("leaves paths outside the prefix untouched", () => {
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/webhook/something-else/abc-123"));
    expect(headers.has("x-agent-token")).toBe(false);
  });

  test("does not leak onto the REST API surface", () => {
    // The whole point of scoping: an API call must not carry a webhook secret.
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/api/v1/workflows"));
    expect(headers.has("x-agent-token")).toBe(false);
  });

  test("a prefix without a trailing slash does not spill into sibling paths", () => {
    // /webhook/agent must not match /webhook/agentic/... — hence the trailing
    // slash in the documented prefix form.
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/webhook/agentic/abc"));
    expect(headers.has("x-agent-token")).toBe(false);
  });

  test("routes each family to its own token", () => {
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule, testRule] });

    const a = new Headers();
    mw.apply(a, ctx("/webhook/agent/x"));
    expect(a.get("x-agent-token")).toBe("agent-secret");
    expect(a.has("x-cli-test-token")).toBe(false);

    const b = new Headers();
    mw.apply(b, ctx("/webhook/cli-test/x"));
    expect(b.get("x-cli-test-token")).toBe("cli-test-secret");
    expect(b.has("x-agent-token")).toBe(false);
  });

  test("applies every matching rule, not just the first", () => {
    // A broad rule plus a narrower one on top: both headers must arrive.
    const broad = { ...agentRule, pathPrefix: "/webhook/", header: "x-broad", token: "broad" };
    const mw = new WebhookTokenInjectMiddleware({ rules: [broad, agentRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/webhook/agent/x"));
    expect(headers.get("x-broad")).toBe("broad");
    expect(headers.get("x-agent-token")).toBe("agent-secret");
  });

  test("when matching rules share a header the later one wins", () => {
    const first = { ...agentRule, token: "first", conflictPolicy: "replace" as const };
    const second = { ...agentRule, token: "second", conflictPolicy: "replace" as const };
    const mw = new WebhookTokenInjectMiddleware({ rules: [first, second] });
    const headers = new Headers();
    mw.apply(headers, ctx("/webhook/agent/x"));
    expect(headers.get("x-agent-token")).toBe("second");
  });

  test("set-if-absent keeps a caller-supplied token", () => {
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule] });
    const headers = new Headers({ "x-agent-token": "caller-owned" });
    mw.apply(headers, ctx("/webhook/agent/x"));
    expect(headers.get("x-agent-token")).toBe("caller-owned");
  });

  test("replace makes the proxy the single token holder", () => {
    const mw = new WebhookTokenInjectMiddleware({
      rules: [{ ...agentRule, conflictPolicy: "replace" }],
    });
    const headers = new Headers({ "x-agent-token": "caller-owned" });
    mw.apply(headers, ctx("/webhook/agent/x"));
    expect(headers.get("x-agent-token")).toBe("agent-secret");
  });

  test("header matching is case-insensitive, so a differently-cased caller value is honoured", () => {
    // Headers normalises names; set-if-absent must not double-write.
    const mw = new WebhookTokenInjectMiddleware({ rules: [agentRule] });
    const headers = new Headers({ "X-Agent-Token": "caller-owned" });
    mw.apply(headers, ctx("/webhook/agent/x"));
    expect(headers.get("x-agent-token")).toBe("caller-owned");
  });

  test("no rules configured is inert rather than throwing", () => {
    // The factory rejects an empty rule set; the class itself stays total.
    const mw = new WebhookTokenInjectMiddleware({ rules: [] });
    const headers = new Headers();
    mw.apply(headers, ctx("/webhook/agent/x"));
    expect([...headers.keys()]).toEqual([]);
  });
});

describe("webhookTokenInjectOptionsSchema", () => {
  test("defaults conflictPolicy to set-if-absent", () => {
    const parsed = webhookTokenInjectOptionsSchema.parse({
      rules: [{ pathPrefix: "/webhook/a/", header: "x-a", token: "t" }],
    });
    expect(parsed.rules[0]!.conflictPolicy).toBe("set-if-absent");
  });

  test("rejects an empty rule set", () => {
    expect(() => webhookTokenInjectOptionsSchema.parse({ rules: [] })).toThrow(/at least one rule/);
  });

  test("rejects a prefix that is not absolute", () => {
    expect(() =>
      webhookTokenInjectOptionsSchema.parse({
        rules: [{ pathPrefix: "webhook/a/", header: "x-a", token: "t" }],
      }),
    ).toThrow(/must start with/);
  });

  test("rejects a header name with illegal characters", () => {
    expect(() =>
      webhookTokenInjectOptionsSchema.parse({
        rules: [{ pathPrefix: "/webhook/a/", header: "x a", token: "t" }],
      }),
    ).toThrow(/valid HTTP header name/);
  });

  test("rejects a rule carrying neither token nor tokenEnvVar", () => {
    expect(() =>
      webhookTokenInjectOptionsSchema.parse({
        rules: [{ pathPrefix: "/webhook/a/", header: "x-a" }],
      }),
    ).toThrow(/exactly one of token \/ tokenEnvVar/);
  });

  test("rejects a rule carrying both", () => {
    expect(() =>
      webhookTokenInjectOptionsSchema.parse({
        rules: [{ pathPrefix: "/webhook/a/", header: "x-a", token: "t", tokenEnvVar: "V" }],
      }),
    ).toThrow(/exactly one of token \/ tokenEnvVar/);
  });
});

describe("token resolution", () => {
  test("reads the value named by tokenEnvVar", () => {
    const rules = webhookTokenInjectOptionsSchema.parse({
      rules: [{ pathPrefix: "/webhook/a/", header: "x-a", tokenEnvVar: "SOME_TOKEN" }],
    }).rules;
    const resolved = resolveWebhookTokenRules(rules, { SOME_TOKEN: "from-env" });
    expect(resolved[0]!.token).toBe("from-env");
  });

  test("an unset tokenEnvVar fails loudly instead of injecting nothing", () => {
    const rules = webhookTokenInjectOptionsSchema.parse({
      rules: [{ pathPrefix: "/webhook/a/", header: "x-a", tokenEnvVar: "MISSING_TOKEN" }],
    }).rules;
    expect(() => resolveWebhookTokenRules(rules, {})).toThrow(/unset or empty/);
  });

  test("an empty tokenEnvVar value is treated as unset", () => {
    const rules = webhookTokenInjectOptionsSchema.parse({
      rules: [{ pathPrefix: "/webhook/a/", header: "x-a", tokenEnvVar: "EMPTY_TOKEN" }],
    }).rules;
    expect(() => resolveWebhookTokenRules(rules, { EMPTY_TOKEN: "" })).toThrow(/unset or empty/);
  });
});

describe("webhookTokenInjectFactory config loading", () => {
  test("parses a rule set from env", () => {
    const loaded = webhookTokenInjectFactory.loadFromEnv({
      N8N_WEBHOOK_TOKEN_INJECT_RULES: JSON.stringify([
        { pathPrefix: "/webhook/a/", header: "x-a", token: "t" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(loaded.rules).toHaveLength(1);
  });

  test("absent env yields no options rather than an empty rule set", () => {
    // Distinguishing the two matters: {} lets CLI flags supply the rules,
    // while {rules: []} would fail schema validation before they are merged.
    expect(webhookTokenInjectFactory.loadFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });

  test("malformed JSON names the source it came from", () => {
    expect(() =>
      webhookTokenInjectFactory.loadFromEnv({
        N8N_WEBHOOK_TOKEN_INJECT_RULES: "{not json",
      } as NodeJS.ProcessEnv),
    ).toThrow(/N8N_WEBHOOK_TOKEN_INJECT_RULES is not valid JSON/);
  });

  test("a JSON object instead of an array is rejected", () => {
    expect(() =>
      webhookTokenInjectFactory.loadFromEnv({
        N8N_WEBHOOK_TOKEN_INJECT_RULES: '{"pathPrefix":"/webhook/a/"}',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be a JSON array/);
  });

  test("CLI flags parse the same shape", () => {
    const loaded = webhookTokenInjectFactory.loadFromCLI({
      webhookTokenInjectRules: JSON.stringify([
        { pathPrefix: "/webhook/a/", header: "x-a", token: "t" },
      ]),
    });
    expect(loaded.rules).toHaveLength(1);
  });

  test("build resolves env indirection end to end", () => {
    process.env.WTI_TEST_TOKEN = "resolved-secret";
    try {
      const mw = webhookTokenInjectFactory.build({
        rules: [{ pathPrefix: "/webhook/a/", header: "x-a", tokenEnvVar: "WTI_TEST_TOKEN" }],
      });
      const headers = new Headers();
      mw.apply(headers, ctx("/webhook/a/x"));
      expect(headers.get("x-a")).toBe("resolved-secret");
    } finally {
      process.env.WTI_TEST_TOKEN = undefined;
    }
  });
});
