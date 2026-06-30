import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiKeyInjectFactory } from "@/middleware/builtin/api-key-inject/factory.ts";
import { ApiKeyInjectMiddleware } from "@/middleware/builtin/api-key-inject/middleware.ts";

const baseCtx = {
  request: new Request("http://proxy.local/api/v1/workflows"),
  method: "GET",
  pathname: "/api/v1/workflows",
  upstreamUrl: "http://upstream.local/api/v1/workflows",
};

describe("ApiKeyInjectMiddleware", () => {
  test("sets the configured header to the key value", () => {
    const mw = new ApiKeyInjectMiddleware({
      header: "X-N8N-API-KEY",
      apiKey: "key-1",
      conflictPolicy: "replace",
    });
    const headers = new Headers();
    mw.apply(headers, baseCtx);
    expect(headers.get("X-N8N-API-KEY")).toBe("key-1");
  });

  test("replace policy overwrites an incoming header value", () => {
    const mw = new ApiKeyInjectMiddleware({
      header: "X-N8N-API-KEY",
      apiKey: "shared",
      conflictPolicy: "replace",
    });
    const headers = new Headers({ "X-N8N-API-KEY": "client-supplied" });
    mw.apply(headers, baseCtx);
    expect(headers.get("X-N8N-API-KEY")).toBe("shared");
  });

  test("set-if-absent policy leaves an incoming value intact", () => {
    const mw = new ApiKeyInjectMiddleware({
      header: "X-N8N-API-KEY",
      apiKey: "shared",
      conflictPolicy: "set-if-absent",
    });
    const headers = new Headers({ "X-N8N-API-KEY": "client-supplied" });
    mw.apply(headers, baseCtx);
    expect(headers.get("X-N8N-API-KEY")).toBe("client-supplied");
  });

  test("set-if-absent policy sets when missing", () => {
    const mw = new ApiKeyInjectMiddleware({
      header: "X-N8N-API-KEY",
      apiKey: "shared",
      conflictPolicy: "set-if-absent",
    });
    const headers = new Headers();
    mw.apply(headers, baseCtx);
    expect(headers.get("X-N8N-API-KEY")).toBe("shared");
  });

  test("custom header name", () => {
    const mw = new ApiKeyInjectMiddleware({
      header: "X-Custom-Key",
      apiKey: "v",
      conflictPolicy: "replace",
    });
    const headers = new Headers();
    mw.apply(headers, baseCtx);
    expect(headers.get("X-Custom-Key")).toBe("v");
    expect(headers.has("X-N8N-API-KEY")).toBe(false);
  });
});

describe("apiKeyInjectFactory", () => {
  test("rejects when apiKey missing", () => {
    expect(() => apiKeyInjectFactory.build({})).toThrow();
  });

  test("loadFromEnv reads N8N_API_KEY_INJECT_KEY directly", () => {
    const partial = apiKeyInjectFactory.loadFromEnv({ N8N_API_KEY_INJECT_KEY: "direct-key" });
    expect(partial.apiKey).toBe("direct-key");
  });

  test("loadFromEnv resolves indirection via N8N_API_KEY_INJECT_KEY_ENV_VAR", () => {
    const partial = apiKeyInjectFactory.loadFromEnv({
      N8N_API_KEY_INJECT_KEY_ENV_VAR: "MY_SECRET",
      MY_SECRET: "resolved-key",
    });
    expect(partial.apiKey).toBe("resolved-key");
  });

  test("direct key wins over indirection when both present", () => {
    const partial = apiKeyInjectFactory.loadFromEnv({
      N8N_API_KEY_INJECT_KEY: "direct",
      N8N_API_KEY_INJECT_KEY_ENV_VAR: "OTHER",
      OTHER: "indirect",
    });
    expect(partial.apiKey).toBe("direct");
  });

  describe("loadFromCLI", () => {
    const savedEnv = process.env.SHARED_N8N_KEY_FOR_TESTS;

    beforeEach(() => {
      process.env.SHARED_N8N_KEY_FOR_TESTS = "cli-resolved";
    });
    afterEach(() => {
      if (savedEnv === undefined) delete process.env.SHARED_N8N_KEY_FOR_TESTS;
      else process.env.SHARED_N8N_KEY_FOR_TESTS = savedEnv;
    });

    test("resolves the key via the named env var", () => {
      const partial = apiKeyInjectFactory.loadFromCLI({
        apiKeyInjectKeyEnvVar: "SHARED_N8N_KEY_FOR_TESTS",
      });
      expect(partial.apiKey).toBe("cli-resolved");
    });

    test("does not surface the raw key under any other CLI key — only the env-var name is honored", () => {
      // Even if a hypothetical "apiKeyInjectKey" is passed, the factory ignores it
      // because the raw key must never come from the CLI.
      const partial = apiKeyInjectFactory.loadFromCLI({
        apiKeyInjectKey: "raw-on-cli",
      } as Record<string, unknown>);
      expect(partial.apiKey).toBeUndefined();
    });
  });

  test("defaults header to X-N8N-API-KEY and conflictPolicy to replace", async () => {
    const mw = apiKeyInjectFactory.build({ apiKey: "k" });
    const headers = new Headers({ "X-N8N-API-KEY": "preexisting" });
    await mw.apply(headers, baseCtx);
    expect(headers.get("X-N8N-API-KEY")).toBe("k");
  });

  test("custom conflictPolicy from env", async () => {
    const partial = apiKeyInjectFactory.loadFromEnv({
      N8N_API_KEY_INJECT_KEY: "k",
      N8N_API_KEY_INJECT_CONFLICT_POLICY: "set-if-absent",
    });
    const mw = apiKeyInjectFactory.build(partial);
    const headers = new Headers({ "X-N8N-API-KEY": "user" });
    await mw.apply(headers, baseCtx);
    expect(headers.get("X-N8N-API-KEY")).toBe("user");
  });
});
