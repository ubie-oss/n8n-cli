import { describe, expect, test } from "bun:test";
import {
  bearerTokenInjectFactory,
  resolveBearerTokenRules,
} from "@/middleware/builtin/bearer-token-inject/factory.ts";
import { BearerTokenInjectMiddleware } from "@/middleware/builtin/bearer-token-inject/middleware.ts";
import type { ClientMiddlewareContext } from "@/middleware/types.ts";

function ctx(pathname: string): ClientMiddlewareContext {
  return {
    request: new Request(`http://proxy.local${pathname}`),
    method: "POST",
    pathname,
    upstreamUrl: `http://upstream.local${pathname}`,
  };
}

const mcpRule = { pathPrefix: "/mcp-server/", token: "mcp-secret", scheme: "Bearer" };

describe("BearerTokenInjectMiddleware", () => {
  test("injects Authorization on a matching path", () => {
    const mw = new BearerTokenInjectMiddleware({ rules: [mcpRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/mcp-server/http"));
    expect(headers.get("authorization")).toBe("Bearer mcp-secret");
  });

  test("leaves a non-matching path completely untouched", () => {
    const mw = new BearerTokenInjectMiddleware({ rules: [mcpRule] });
    const headers = new Headers({ "x-n8n-api-key": "k" });
    mw.apply(headers, ctx("/api/v1/workflows"));
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-n8n-api-key")).toBe("k");
  });

  test("the trailing slash keeps a sibling prefix out", () => {
    const mw = new BearerTokenInjectMiddleware({ rules: [mcpRule] });
    const headers = new Headers();
    mw.apply(headers, ctx("/mcp-server-admin/http"));
    expect(headers.get("authorization")).toBeNull();
  });

  test("never touches Proxy-Authorization, which belongs to the gateway hop", () => {
    const mw = new BearerTokenInjectMiddleware({ rules: [mcpRule] });
    const headers = new Headers({ "proxy-authorization": "Bearer iap-token" });
    mw.apply(headers, ctx("/mcp-server/http"));
    expect(headers.get("proxy-authorization")).toBe("Bearer iap-token");
    expect(headers.get("authorization")).toBe("Bearer mcp-secret");
  });

  test("the last matching rule wins", () => {
    const mw = new BearerTokenInjectMiddleware({
      rules: [
        { pathPrefix: "/mcp-server/", token: "broad", scheme: "Bearer" },
        { pathPrefix: "/mcp-server/http", token: "narrow", scheme: "Bearer" },
      ],
    });
    const headers = new Headers();
    mw.apply(headers, ctx("/mcp-server/http"));
    expect(headers.get("authorization")).toBe("Bearer narrow");
  });

  test("an empty scheme writes the raw value", () => {
    const mw = new BearerTokenInjectMiddleware({
      rules: [{ pathPrefix: "/mcp-server/", token: "raw-value", scheme: "" }],
    });
    const headers = new Headers();
    mw.apply(headers, ctx("/mcp-server/http"));
    expect(headers.get("authorization")).toBe("raw-value");
  });
});

describe("bearerTokenInjectFactory", () => {
  test("rejects an empty rule set rather than injecting nothing silently", () => {
    expect(() => bearerTokenInjectFactory.build({ rules: [] })).toThrow(/at least one rule/);
  });

  test("rejects a rule with both token and tokenEnvVar", () => {
    expect(() =>
      bearerTokenInjectFactory.build({
        rules: [{ pathPrefix: "/mcp-server/", token: "a", tokenEnvVar: "B" }],
      }),
    ).toThrow(/exactly one of token \/ tokenEnvVar/);
  });

  test("rejects a rule with neither token nor tokenEnvVar", () => {
    expect(() =>
      bearerTokenInjectFactory.build({ rules: [{ pathPrefix: "/mcp-server/" }] }),
    ).toThrow(/exactly one of token \/ tokenEnvVar/);
  });

  test("rejects a pathPrefix that is not a path", () => {
    expect(() =>
      bearerTokenInjectFactory.build({ rules: [{ pathPrefix: "mcp-server", token: "a" }] }),
    ).toThrow(/must start with/);
  });

  test("scheme defaults to Bearer", () => {
    const mw = bearerTokenInjectFactory.build({
      rules: [{ pathPrefix: "/mcp-server/", token: "t" }],
    });
    const headers = new Headers();
    mw.apply(headers, ctx("/mcp-server/http"));
    expect(headers.get("authorization")).toBe("Bearer t");
  });

  test("loadFromEnv parses the rule JSON", () => {
    const partial = bearerTokenInjectFactory.loadFromEnv({
      N8N_BEARER_TOKEN_INJECT_RULES: '[{"pathPrefix":"/mcp-server/","tokenEnvVar":"MCP_TOKEN"}]',
    });
    expect(partial.rules).toHaveLength(1);
    expect(partial.rules?.[0]?.pathPrefix).toBe("/mcp-server/");
  });

  test("loadFromEnv reports malformed JSON against the env var name", () => {
    expect(() =>
      bearerTokenInjectFactory.loadFromEnv({ N8N_BEARER_TOKEN_INJECT_RULES: "{not json" }),
    ).toThrow(/N8N_BEARER_TOKEN_INJECT_RULES is not valid JSON/);
  });

  test("loadFromEnv rejects a non-array payload", () => {
    expect(() =>
      bearerTokenInjectFactory.loadFromEnv({ N8N_BEARER_TOKEN_INJECT_RULES: '{"a":1}' }),
    ).toThrow(/must be a JSON array/);
  });

  test("loadFromCLI parses the rule JSON", () => {
    const partial = bearerTokenInjectFactory.loadFromCLI({
      bearerTokenInjectRules: '[{"pathPrefix":"/mcp-server/","token":"t"}]',
    });
    expect(partial.rules).toHaveLength(1);
  });

  test("resolveBearerTokenRules reads the token out of the environment", () => {
    const resolved = resolveBearerTokenRules(
      [{ pathPrefix: "/mcp-server/", tokenEnvVar: "MCP_TOKEN", scheme: "Bearer" }],
      { MCP_TOKEN: "from-env" },
    );
    expect(resolved[0]?.token).toBe("from-env");
  });

  test("an unset tokenEnvVar fails loudly instead of injecting nothing", () => {
    expect(() =>
      resolveBearerTokenRules(
        [{ pathPrefix: "/mcp-server/", tokenEnvVar: "MISSING_TOKEN", scheme: "Bearer" }],
        {},
      ),
    ).toThrow(/MISSING_TOKEN.*unset or empty/);
  });
});
