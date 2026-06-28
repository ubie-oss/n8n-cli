import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildMiddlewares,
  parseMiddlewareList,
  registerFactory,
  resetRegistry,
  resolveEnabledList,
} from "@/middleware/registry.ts";
import type { MiddlewareFactory } from "@/middleware/types.ts";

interface FakeOptions {
  fromEnv?: string;
  fromCli?: string;
  required?: string;
}

function fakeFactory(name: string): MiddlewareFactory<FakeOptions> {
  return {
    name,
    loadFromEnv: (env) => ({ fromEnv: env[`${name.toUpperCase()}_FROM_ENV`] }),
    loadFromCLI: (opts) => {
      const raw = opts[`${name}FromCli`];
      return typeof raw === "string" ? { fromCli: raw } : {};
    },
    build: (opts) => {
      const o = opts as FakeOptions;
      if (!o.required && !o.fromEnv && !o.fromCli) {
        throw new Error(`${name}: at least one option must be provided`);
      }
      return {
        name,
        evaluate: () => ({ block: false, violations: [] }),
      };
    },
  };
}

beforeEach(() => resetRegistry());
afterEach(() => resetRegistry());

describe("parseMiddlewareList", () => {
  test("comma-separated", () => {
    expect(parseMiddlewareList("a,b,c")).toEqual(["a", "b", "c"]);
  });
  test("space-separated", () => {
    expect(parseMiddlewareList("a b  c")).toEqual(["a", "b", "c"]);
  });
  test("empty and undefined", () => {
    expect(parseMiddlewareList("")).toEqual([]);
    expect(parseMiddlewareList(undefined)).toEqual([]);
  });
});

describe("resolveEnabledList precedence", () => {
  test("CLI wins over env", () => {
    expect(
      resolveEnabledList({
        cliValue: "lint,authz",
        env: { N8N_MIDDLEWARES: "lint" },
        envVar: "N8N_MIDDLEWARES",
        fallback: ["lint"],
      }),
    ).toEqual(["lint", "authz"]);
  });
  test("env wins over fallback", () => {
    expect(
      resolveEnabledList({
        cliValue: undefined,
        env: { N8N_MIDDLEWARES: "authz" },
        envVar: "N8N_MIDDLEWARES",
        fallback: ["lint"],
      }),
    ).toEqual(["authz"]);
  });
  test("fallback when neither is set", () => {
    expect(resolveEnabledList({ env: {}, envVar: "N8N_MIDDLEWARES", fallback: ["lint"] })).toEqual([
      "lint",
    ]);
  });
});

describe("buildMiddlewares", () => {
  test("env-only options reach build()", () => {
    registerFactory(fakeFactory("f1"));
    const built = buildMiddlewares({
      enabled: ["f1"],
      env: { F1_FROM_ENV: "env-value" },
      cliOpts: {},
    });
    expect(built).toHaveLength(1);
    expect(built[0]?.name).toBe("f1");
  });

  test("CLI options override env options", () => {
    let observed: unknown;
    const f: MiddlewareFactory<FakeOptions> = {
      name: "obs",
      loadFromEnv: () => ({ fromEnv: "env" }),
      loadFromCLI: () => ({ fromEnv: "cli" }),
      build: (o) => {
        observed = o;
        return { name: "obs", evaluate: () => ({ block: false, violations: [] }) };
      },
    };
    registerFactory(f);
    buildMiddlewares({ enabled: ["obs"] });
    expect((observed as FakeOptions).fromEnv).toBe("cli");
  });

  test("unknown middleware name throws with a friendly hint", () => {
    registerFactory(fakeFactory("known"));
    expect(() => buildMiddlewares({ enabled: ["nope"] })).toThrow(/Unknown middleware "nope"/);
  });

  test("build() error propagates with middleware name in message", () => {
    registerFactory(fakeFactory("strict"));
    expect(() => buildMiddlewares({ enabled: ["strict"], env: {}, cliOpts: {} })).toThrow(
      /strict: at least one option must be provided/,
    );
  });
});
