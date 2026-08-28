import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRcApiSection,
  deepMergeRc,
  findProjectRcFile,
  findUserRcFile,
  interpolateEnvStrings,
  loadRc,
  parseRcDuration,
  parseRcFile,
  type RcApiSection,
  warnLiteralSecretsInRc,
} from "@/config/rc.ts";

let tmpDir: string;
let xdgDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-test-"));
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-xdg-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(xdgDir, { recursive: true, force: true });
});

/** Env that isolates the loader from the developer's real user config. */
function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: xdgDir, HOME: xdgDir, ...overrides };
}

describe("interpolateEnvStrings", () => {
  test("expands ${VAR} in strings, recursively", () => {
    const env = { A: "alpha", B: "beta" };
    const out = interpolateEnvStrings(
      { a: "${A}", nested: { list: ["${B}", 1, true, null] } },
      env,
    );
    expect(out).toEqual({ a: "alpha", nested: { list: ["beta", 1, true, null] } });
  });

  test("leaves strings without references untouched", () => {
    expect(interpolateEnvStrings("${not-a-ref} and $ALSO_NOT", {})).toBe(
      "${not-a-ref} and $ALSO_NOT",
    );
  });

  test("throws on an undefined variable instead of injecting an empty string", () => {
    expect(() => interpolateEnvStrings("${MISSING_VAR}", {}, "rc.json")).toThrow(
      /\$\{MISSING_VAR\} \(rc\.json\)/,
    );
  });
});

describe("deepMergeRc", () => {
  test("merges nested objects, replaces arrays and scalars", () => {
    const out = deepMergeRc(
      { api: { url: "a", timeout: "1s" }, proxy: { tags: ["x"], enforce: "warn" } },
      { api: { timeout: "2s" }, proxy: { tags: ["y", "z"] } },
    );
    expect(out).toEqual({
      api: { url: "a", timeout: "2s" },
      proxy: { tags: ["y", "z"], enforce: "warn" },
    });
  });

  test("override undefined values are ignored", () => {
    expect(deepMergeRc({ a: 1 }, { a: undefined, b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe("findProjectRcFile", () => {
  test("prefers .n8nctlrc.json over .n8nlintrc.json in the same directory", () => {
    const lintrc = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(lintrc, "{}");
    const ctlrc = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(ctlrc, "{}");
    expect(findProjectRcFile(tmpDir)).toBe(ctlrc);
  });

  test("falls back to legacy .n8nlintrc.json", () => {
    const lintrc = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(lintrc, "{}");
    expect(findProjectRcFile(tmpDir)).toBe(lintrc);
  });

  test("nearest directory wins", () => {
    fs.writeFileSync(path.join(tmpDir, ".n8nctlrc.json"), "{}");
    const sub = path.join(tmpDir, "sub");
    fs.mkdirSync(sub);
    const child = path.join(sub, ".n8nctlrc.json");
    fs.writeFileSync(child, "{}");
    expect(findProjectRcFile(sub)).toBe(child);
  });

  test("returns undefined when no config exists", () => {
    expect(findProjectRcFile(tmpDir)).toBeUndefined();
  });
});

describe("findUserRcFile", () => {
  test("honors XDG_CONFIG_HOME", () => {
    expect(findUserRcFile({ XDG_CONFIG_HOME: "/custom/cfg" })).toBe(
      path.join("/custom/cfg", "n8nctl", "config.json"),
    );
  });

  test("falls back to $HOME/.config", () => {
    expect(findUserRcFile({ HOME: "/home/u" })).toBe(
      path.join("/home/u", ".config", "n8nctl", "config.json"),
    );
  });
});

describe("parseRcFile", () => {
  test("parses an all-in-one file", () => {
    const file = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ api: { url: "https://x" }, middlewares: { client: ["iap-auth"] } }),
    );
    expect(parseRcFile(file, {})).toEqual({
      api: { url: "https://x" },
      middlewares: { client: ["iap-auth"] },
    });
  });

  test("treats a legacy .n8nlintrc.json as the lint section", () => {
    const file = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(file, JSON.stringify({ rules: { "json-syntax": false } }));
    const rc = parseRcFile(file, {});
    expect(rc.lint).toEqual({ rules: { "json-syntax": false } });
    expect(rc.api).toBeUndefined();
  });

  test("wraps JSON syntax errors with the file path", () => {
    const file = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => parseRcFile(file, {})).toThrow(/Failed to parse configuration file/);
  });

  test("rejects non-object sections", () => {
    const file = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(file, JSON.stringify({ api: "https://x" }));
    expect(() => parseRcFile(file, {})).toThrow(/Invalid "api" section/);
  });

  test("rejects non-string-array middleware lists", () => {
    const file = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(file, JSON.stringify({ middlewares: { client: [1, 2] } }));
    expect(() => parseRcFile(file, {})).toThrow(/middlewares\.client/);
  });

  test("rejects negative numeric proxy fields", () => {
    const file = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(file, JSON.stringify({ proxy: { duplicateTtlMs: -1 } }));
    expect(() => parseRcFile(file, {})).toThrow(/proxy\.duplicateTtlMs/);
  });

  test("interpolates ${VAR} during load", () => {
    const file = path.join(tmpDir, ".n8nctlrc.json");
    fs.writeFileSync(file, JSON.stringify({ api: { apiKey: "${MY_KEY}" } }));
    expect(parseRcFile(file, { MY_KEY: "secret" }).api?.apiKey).toBe("secret");
  });
});

describe("loadRc", () => {
  test("returns empty config when no files exist", () => {
    const rc = loadRc({ env: testEnv(), cwd: tmpDir });
    expect(rc.config).toEqual({});
    expect(rc.sources).toEqual({});
  });

  test("merges user < project (project wins on conflict)", () => {
    fs.mkdirSync(path.join(xdgDir, "n8nctl"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgDir, "n8nctl", "config.json"),
      JSON.stringify({ api: { url: "user-url", apiKey: "user-key" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { url: "project-url" } }),
    );

    const rc = loadRc({ env: testEnv(), cwd: tmpDir });
    expect(rc.config.api).toEqual({ url: "project-url", apiKey: "user-key" });
    expect(rc.sources.user).toBeDefined();
    expect(rc.sources.project).toBe(path.join(tmpDir, ".n8nctlrc.json"));
  });

  test("explicit configPath replaces the project layer and wins over user", () => {
    fs.mkdirSync(path.join(xdgDir, "n8nctl"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgDir, "n8nctl", "config.json"),
      JSON.stringify({ api: { url: "user-url", timeout: "5s" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { url: "project-url" } }),
    );
    const explicit = path.join(tmpDir, "other.json");
    fs.writeFileSync(explicit, JSON.stringify({ api: { url: "explicit-url" } }));

    const rc = loadRc({ env: testEnv(), cwd: tmpDir, configPath: explicit });
    // project file is NOT read when --config is given
    expect(rc.sources.project).toBeUndefined();
    expect(rc.sources.explicit).toBe(explicit);
    expect(rc.config.api).toEqual({ url: "explicit-url", timeout: "5s" });
  });

  test("N8NCTL_CONFIG acts as explicit configPath", () => {
    const explicit = path.join(tmpDir, "via-env.json");
    fs.writeFileSync(explicit, JSON.stringify({ api: { url: "env-url" } }));
    const rc = loadRc({ env: testEnv({ N8NCTL_CONFIG: explicit }), cwd: tmpDir });
    expect(rc.config.api?.url).toBe("env-url");
  });

  test("errors when an explicit config file is missing", () => {
    expect(() =>
      loadRc({ env: testEnv(), cwd: tmpDir, configPath: path.join(tmpDir, "nope.json") }),
    ).toThrow(/Configuration file not found/);
  });

  test("errors on undefined ${VAR} in a config file", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { apiKey: "${MISSING}" } }),
    );
    expect(() => loadRc({ env: testEnv(), cwd: tmpDir })).toThrow(/\$\{MISSING\}/);
  });
});

describe("warnLiteralSecretsInRc", () => {
  let warnings: string[];
  const originalError = console.error;

  beforeEach(() => {
    warnings = [];
    console.error = (msg?: unknown) => warnings.push(String(msg));
  });
  afterEach(() => {
    console.error = originalError;
  });

  test("warns on a literal apiKey in a project file", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { apiKey: "literal-secret" } }),
    );
    warnLiteralSecretsInRc(loadRc({ env: testEnv(), cwd: tmpDir }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/literal api\.apiKey/);
  });

  test("does not warn when the key comes from ${VAR}", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { apiKey: "${MY_KEY}" } }),
    );
    warnLiteralSecretsInRc(loadRc({ env: testEnv({ MY_KEY: "x" }), cwd: tmpDir }));
    expect(warnings).toHaveLength(0);
  });

  test("does not warn on user-level files (not committed to git)", () => {
    fs.mkdirSync(path.join(xdgDir, "n8nctl"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgDir, "n8nctl", "config.json"),
      JSON.stringify({ api: { apiKey: "literal-secret" } }),
    );
    warnLiteralSecretsInRc(loadRc({ env: testEnv(), cwd: tmpDir }));
    expect(warnings).toHaveLength(0);
  });
});

describe("applyRcApiSection", () => {
  test("applies the api section", () => {
    const config = {
      apiURL: "",
      apiKey: "",
      timeoutMs: 30_000,
      output: "json" as "json" | "table",
    };
    const api: RcApiSection = { url: "u", apiKey: "k", timeout: "45s", output: "table" };
    applyRcApiSection(config, api);
    expect(config).toEqual({ apiURL: "u", apiKey: "k", timeoutMs: 45_000, output: "table" });
  });

  test("invalid durations leave the default untouched", () => {
    const config = {
      apiURL: "",
      apiKey: "",
      timeoutMs: 30_000,
      output: "json" as "json" | "table",
    };
    applyRcApiSection(config, { timeout: "soon" });
    expect(config.timeoutMs).toBe(30_000);
  });
});

describe("parseRcDuration", () => {
  test("accepts ms/s/m and plain numbers", () => {
    expect(parseRcDuration("1000")).toBe(1000);
    expect(parseRcDuration("30s")).toBe(30_000);
    expect(parseRcDuration("5m")).toBe(300_000);
    expect(parseRcDuration("250ms")).toBe(250);
    expect(parseRcDuration("bogus")).toBeNull();
  });
});

describe("JSON schema (schemas/n8nctlrc.schema.json)", () => {
  test("is valid JSON and covers every documented section", () => {
    const schemaPath = path.join(process.cwd(), "schemas", "n8nctlrc.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
      properties: Record<string, unknown>;
    };
    for (const section of ["api", "lint", "middlewares", "proxy", "$schema"]) {
      expect(schema.properties[section]).toBeDefined();
    }
    const proxyProps = (schema.properties.proxy as { properties: Record<string, unknown> })
      .properties;
    for (const key of [
      "listen",
      "upstream",
      "enforce",
      "logFormat",
      "logIdentity",
      "allowDuplicates",
      "disableRules",
      "serverMiddlewares",
      "clientMiddlewares",
      "tags",
      "routes",
      "duplicateTtlMs",
      "upstreamTimeoutMs",
    ]) {
      expect(proxyProps[key]).toBeDefined();
    }
  });
});
