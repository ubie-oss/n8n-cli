import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConfigFile, loadLintConfig } from "@/lint/config.ts";

describe("findConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds config in the given directory", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(configPath, '{"rules":{}}');

    const found = findConfigFile(tmpDir);
    expect(found).toBe(configPath);
  });

  test("finds config in a parent directory", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(configPath, '{"rules":{}}');

    const subDir = path.join(tmpDir, "sub", "deep");
    fs.mkdirSync(subDir, { recursive: true });

    const found = findConfigFile(subDir);
    expect(found).toBe(configPath);
  });

  test("returns undefined when no config exists", () => {
    const found = findConfigFile(tmpDir);
    expect(found).toBeUndefined();
  });

  test("returns the nearest config when multiple exist", () => {
    const parentConfig = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(parentConfig, '{"rules":{"json-syntax":true}}');

    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    const childConfig = path.join(subDir, ".n8nlintrc.json");
    fs.writeFileSync(childConfig, '{"rules":{"json-syntax":false}}');

    const found = findConfigFile(subDir);
    expect(found).toBe(childConfig);
  });
});

describe("loadLintConfig auto-discovery", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-config-auto-"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("auto-discovers config from CWD when no path given", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "schedule-trigger-frequency": ["error", { minInterval: "hourly" }],
        },
      }),
    );

    process.chdir(tmpDir);
    const config = loadLintConfig();
    const rc = config.rulesConfig.get("schedule-trigger-frequency");
    expect(rc).toBeDefined();
    expect(rc!.severity).toBe("error");
    expect(rc!.options).toEqual({ minInterval: "hourly" });
  });

  test("returns empty config when no config file exists in CWD", () => {
    process.chdir(tmpDir);
    const config = loadLintConfig();
    expect(config.rulesConfig.size).toBe(0);
  });

  test("explicit path takes precedence over auto-discovery", () => {
    const autoConfig = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(autoConfig, JSON.stringify({ rules: { "json-syntax": "off" } }));

    const explicitDir = path.join(tmpDir, "explicit");
    fs.mkdirSync(explicitDir);
    const explicitConfig = path.join(explicitDir, "custom-lint.json");
    fs.writeFileSync(explicitConfig, JSON.stringify({ rules: { "json-syntax": "error" } }));

    process.chdir(tmpDir);
    const config = loadLintConfig(explicitConfig);
    const rc = config.rulesConfig.get("json-syntax");
    expect(rc).toBeDefined();
    expect(rc!.severity).toBe("error");
  });

  test("rejects malformed project blocks", () => {
    const configPath = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(configPath, JSON.stringify({ projects: { "project-a": "error" } }));

    expect(() => loadLintConfig(configPath)).toThrow(/Invalid project config/);
  });
});
