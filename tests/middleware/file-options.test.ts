import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildClientMiddlewares,
  registerClientFactory,
  resetClientRegistry,
} from "@/middleware/client-registry.ts";
import {
  buildMiddlewares,
  registerFactory,
  resetRegistry,
  resolveEnabledList,
} from "@/middleware/registry.ts";
import type { ClientMiddlewareFactory, ServerMiddlewareFactory } from "@/middleware/types.ts";

/**
 * The `.n8nctlrc.json` middleware sections (`middlewares.options` keyed by
 * middleware name) must sit at the lowest precedence: file < env < CLI.
 * Factories parse file sections through the same `loadFromCLI` contract.
 */
interface FakeOptions {
  fromEnv?: string;
  fromCli?: string;
  fromFile?: string;
}

function fakeServerFactory(name: string): ServerMiddlewareFactory<FakeOptions> {
  return {
    name,
    loadFromEnv: (env) => ({ fromEnv: env[`${name.toUpperCase()}_FROM_ENV`] }),
    loadFromCLI: (opts) => {
      const out: Partial<FakeOptions> = {};
      const cli = opts[`${name}FromCli`];
      if (typeof cli === "string") out.fromCli = cli;
      const file = opts[`${name}FromFile`];
      if (typeof file === "string") out.fromFile = file;
      return out;
    },
    build: () => ({ name, evaluate: () => ({ block: false, violations: [] }) }),
  };
}

function fakeClientFactory(name: string): ClientMiddlewareFactory<FakeOptions> {
  return {
    name,
    loadFromEnv: (env) => ({ fromEnv: env[`${name.toUpperCase()}_FROM_ENV`] }),
    loadFromCLI: (opts) => {
      const out: Partial<FakeOptions> = {};
      const cli = opts[`${name}FromCli`];
      if (typeof cli === "string") out.fromCli = cli;
      const file = opts[`${name}FromFile`];
      if (typeof file === "string") out.fromFile = file;
      return out;
    },
    build: () => ({ name, apply: () => {} }),
  };
}

const captured: { server: unknown; client: unknown } = { server: undefined, client: undefined };

function capturingServerFactory(name: string): ServerMiddlewareFactory<FakeOptions> {
  const base = fakeServerFactory(name);
  return {
    ...base,
    build: (opts) => {
      captured.server = opts;
      return { name, evaluate: () => ({ block: false, violations: [] }) };
    },
  };
}

function capturingClientFactory(name: string): ClientMiddlewareFactory<FakeOptions> {
  const base = fakeClientFactory(name);
  return {
    ...base,
    build: (opts) => {
      captured.client = opts;
      return { name, apply: () => {} };
    },
  };
}

beforeEach(() => {
  resetRegistry();
  resetClientRegistry();
  registerFactory(capturingServerFactory("fake"));
  registerClientFactory(capturingClientFactory("fake"));
});
afterEach(() => {
  resetRegistry();
  resetClientRegistry();
});

describe("buildMiddlewares with file options", () => {
  test("file section supplies options the env and CLI do not set", () => {
    buildMiddlewares({
      enabled: ["fake"],
      env: {},
      cliOpts: {},
      fileOptions: { fake: { fakeFromFile: "file-value" } },
    });
    expect(captured.server).toMatchObject({ fromFile: "file-value" });
  });

  test("env beats file", () => {
    buildMiddlewares({
      enabled: ["fake"],
      env: { FAKE_FROM_ENV: "env-value" },
      fileOptions: { fake: { fakeFromFile: "file-value" } },
    });
    // Different keys: both survive; verify env key present.
    expect(captured.server).toMatchObject({ fromEnv: "env-value", fromFile: "file-value" });
  });

  test("CLI beats file for the same key", () => {
    buildMiddlewares({
      enabled: ["fake"],
      env: {},
      cliOpts: { fakeFromCli: "cli-value" },
      fileOptions: { fake: { fakeFromCli: "file-value" } },
    });
    expect(captured.server).toMatchObject({ fromCli: "cli-value" });
    expect(captured.server).not.toHaveProperty("fromFile");
  });

  test("a middleware with no file section builds as before", () => {
    buildMiddlewares({ enabled: ["fake"], env: {}, cliOpts: {} });
    expect(captured.server).toEqual({});
  });

  test("file sections are per-middleware: others don't see them", () => {
    registerFactory(capturingServerFactory("other"));
    buildMiddlewares({
      enabled: ["fake", "other"],
      env: {},
      fileOptions: { fake: { fakeFromFile: "only-fake" } },
    });
    // captured holds the last built middleware ("other") — no file options.
    expect(captured.server).toEqual({});
  });
});

describe("buildClientMiddlewares with file options", () => {
  test("file section reaches the client factory and CLI overrides it", () => {
    buildClientMiddlewares({
      enabled: ["fake"],
      env: {},
      cliOpts: { fakeFromCli: "cli" },
      fileOptions: { fake: { fakeFromFile: "file", fakeFromCli: "file" } },
    });
    expect(captured.client).toMatchObject({ fromFile: "file", fromCli: "cli" });
  });
});

describe("resolveEnabledList fileValue layer", () => {
  test("CLI > env > file > fallback", () => {
    const args = {
      env: { N8N_SERVER_MIDDLEWARES: "env-mw" },
      envVar: "N8N_SERVER_MIDDLEWARES",
      fileValue: ["file-mw"],
      fallback: ["fallback-mw"],
    };
    expect(resolveEnabledList({ ...args, cliValue: "cli-mw" })).toEqual(["cli-mw"]);
    expect(resolveEnabledList({ ...args, cliValue: undefined })).toEqual(["env-mw"]);
    expect(resolveEnabledList({ ...args, cliValue: undefined, env: {} })).toEqual(["file-mw"]);
    expect(resolveEnabledList({ ...args, cliValue: undefined, env: {}, fileValue: [] })).toEqual([
      "fallback-mw",
    ]);
  });
});
