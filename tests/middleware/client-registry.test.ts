import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildClientMiddlewares,
  registerClientFactory,
  resetClientRegistry,
} from "@/middleware/client-registry.ts";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";

interface FakeOptions {
  fromEnv?: string;
  fromCli?: string;
  nested?: { a?: string; b?: string };
}

function fakeFactory(name: string): ClientMiddlewareFactory<FakeOptions> {
  return {
    name,
    loadFromEnv: (env) => ({ fromEnv: env[`${name.toUpperCase()}_FROM_ENV`] }),
    loadFromCLI: (opts) => {
      const raw = opts[`${name}FromCli`];
      return typeof raw === "string" ? { fromCli: raw } : {};
    },
    build: (opts) => {
      const o = opts as FakeOptions;
      return {
        name,
        apply: (h) => {
          if (o.fromCli) h.set("X-From-Cli", o.fromCli);
          if (o.fromEnv) h.set("X-From-Env", o.fromEnv);
        },
      };
    },
  };
}

beforeEach(() => resetClientRegistry());
afterEach(() => resetClientRegistry());

describe("buildClientMiddlewares", () => {
  test("env-only options reach build()", () => {
    registerClientFactory(fakeFactory("f1"));
    const built = buildClientMiddlewares({
      enabled: ["f1"],
      env: { F1_FROM_ENV: "env-value" },
      cliOpts: {},
    });
    expect(built).toHaveLength(1);
    expect(built[0]?.name).toBe("f1");
  });

  test("CLI options override env options", () => {
    let observed: unknown;
    const f: ClientMiddlewareFactory<FakeOptions> = {
      name: "obs",
      loadFromEnv: () => ({ fromEnv: "env" }),
      loadFromCLI: () => ({ fromEnv: "cli" }),
      build: (o) => {
        observed = o;
        return { name: "obs", apply: () => {} };
      },
    };
    registerClientFactory(f);
    buildClientMiddlewares({ enabled: ["obs"] });
    expect((observed as FakeOptions).fromEnv).toBe("cli");
  });

  test("unknown client middleware name throws with a friendly hint", () => {
    registerClientFactory(fakeFactory("known"));
    expect(() => buildClientMiddlewares({ enabled: ["nope"] })).toThrow(
      /Unknown client middleware "nope"/,
    );
  });

  test("nested options bucket: CLI partial override merges with env fields", () => {
    let observed: unknown;
    const f: ClientMiddlewareFactory<FakeOptions> = {
      name: "nested",
      loadFromEnv: () => ({ nested: { a: "env-a", b: "env-b" } }),
      loadFromCLI: () => ({ nested: { a: "cli-a" } }),
      build: (o) => {
        observed = o;
        return { name: "nested", apply: () => {} };
      },
    };
    registerClientFactory(f);
    buildClientMiddlewares({ enabled: ["nested"] });
    expect((observed as { nested: { a: string; b: string } }).nested).toEqual({
      a: "cli-a",
      b: "env-b",
    });
  });

  test("two middlewares claiming one header are refused, naming both", () => {
    const owner = (name: string, header: string): ClientMiddlewareFactory<FakeOptions> => ({
      name,
      loadFromEnv: () => ({}),
      loadFromCLI: () => ({}),
      build: () => ({ name, ownedHeaders: [header], apply: () => {} }),
    });
    registerClientFactory(owner("first", "Authorization"));
    registerClientFactory(owner("second", "authorization"));
    expect(() => buildClientMiddlewares({ enabled: ["first", "second"] })).toThrow(
      /"first" and "second" both write the "authorization" header/,
    );
  });

  test("claims on different headers coexist", () => {
    const owner = (name: string, header: string): ClientMiddlewareFactory<FakeOptions> => ({
      name,
      loadFromEnv: () => ({}),
      loadFromCLI: () => ({}),
      build: () => ({ name, ownedHeaders: [header], apply: () => {} }),
    });
    registerClientFactory(owner("gate", "proxy-authorization"));
    registerClientFactory(owner("app", "authorization"));
    expect(buildClientMiddlewares({ enabled: ["gate", "app"] })).toHaveLength(2);
  });

  test("preserves middleware order", () => {
    registerClientFactory(fakeFactory("a"));
    registerClientFactory(fakeFactory("b"));
    const built = buildClientMiddlewares({
      enabled: ["b", "a"],
      env: { A_FROM_ENV: "x", B_FROM_ENV: "y" },
    });
    expect(built.map((m) => m.name)).toEqual(["b", "a"]);
  });
});
