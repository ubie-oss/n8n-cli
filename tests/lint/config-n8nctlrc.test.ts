import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConfigFile, loadLintConfig } from "@/lint/config.ts";

/**
 * Integration between `.n8nctlrc.json` (all-in-one) and the lint config
 * loader: discovery order, the `lint` section, and user < project merge.
 */
describe("lint config via .n8nctlrc.json", () => {
  const originalCwd = process.cwd();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let tmpDir: string;
  let xdgDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-ctlrc-"));
    xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-ctlrc-xdg-"));
    process.env.XDG_CONFIG_HOME = xdgDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.XDG_CONFIG_HOME = originalXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(xdgDir, { recursive: true, force: true });
  });

  function writeUserConfig(config: unknown): void {
    fs.mkdirSync(path.join(xdgDir, "n8nctl"), { recursive: true });
    fs.writeFileSync(path.join(xdgDir, "n8nctl", "config.json"), JSON.stringify(config));
  }

  test("findConfigFile prefers .n8nctlrc.json over .n8nlintrc.json", () => {
    fs.writeFileSync(path.join(tmpDir, ".n8nlintrc.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, ".n8nctlrc.json"), "{}");
    expect(findConfigFile(tmpDir)).toBe(path.join(tmpDir, ".n8nctlrc.json"));
  });

  test("auto-discovery reads the lint section of .n8nctlrc.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({
        api: { url: "https://x" },
        lint: { rules: { "schedule-trigger-frequency": ["error", { minInterval: "hourly" }] } },
      }),
    );
    process.chdir(tmpDir);
    const config = loadLintConfig();
    const rc = config.rulesConfig.get("schedule-trigger-frequency");
    expect(rc).toBeDefined();
    expect(rc!.severity).toBe("error");
    expect(rc!.options).toEqual({ minInterval: "hourly" });
  });

  test("legacy .n8nlintrc.json still auto-discovers (rules at the root)", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nlintrc.json"),
      JSON.stringify({ rules: { "json-syntax": "off" } }),
    );
    process.chdir(tmpDir);
    const config = loadLintConfig();
    expect(config.rulesConfig.get("json-syntax")?.enabled).toBe(false);
  });

  test("user-level lint merges under project-level (project wins)", () => {
    writeUserConfig({
      lint: { rules: { "json-syntax": "warning", "orphaned-node": "off" } },
    });
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ lint: { rules: { "json-syntax": "error" } } }),
    );
    process.chdir(tmpDir);
    const config = loadLintConfig();
    expect(config.rulesConfig.get("json-syntax")?.severity).toBe("error");
    expect(config.rulesConfig.get("orphaned-node")?.enabled).toBe(false);
  });

  test("explicit --lint-config path still wins over everything", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ lint: { rules: { "json-syntax": "off" } } }),
    );
    const explicit = path.join(tmpDir, "custom.json");
    fs.writeFileSync(explicit, JSON.stringify({ rules: { "json-syntax": "error" } }));
    process.chdir(tmpDir);
    expect(loadLintConfig(explicit).rulesConfig.get("json-syntax")?.severity).toBe("error");
  });

  test("an explicit .n8nctlrc.json path reads its lint section", () => {
    const subdir = path.join(tmpDir, "elsewhere");
    fs.mkdirSync(subdir);
    const explicit = path.join(subdir, ".n8nctlrc.json");
    fs.writeFileSync(
      explicit,
      JSON.stringify({ api: { url: "https://x" }, lint: { rules: { "json-syntax": false } } }),
    );
    expect(loadLintConfig(explicit).rulesConfig.get("json-syntax")?.enabled).toBe(false);
  });

  test("per-project rule overrides work from the all-in-one file", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({
        lint: { projects: { "proj-1": { rules: { "orphaned-node": "off" } } } },
      }),
    );
    process.chdir(tmpDir);
    const config = loadLintConfig();
    expect(config.projectRulesConfig.get("proj-1")?.get("orphaned-node")?.enabled).toBe(false);
  });
});
