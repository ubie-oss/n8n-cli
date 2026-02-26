import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLintFile, loadLintFileWithoutIncludes, scanFiles } from "@/lint/scanner.ts";

describe("scanFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-scanner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds .json files", () => {
    fs.writeFileSync(path.join(tmpDir, "wf.json"), "{}");
    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("wf.json");
  });

  test("finds .yaml files", () => {
    fs.writeFileSync(path.join(tmpDir, "wf.yaml"), "name: test");
    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("wf.yaml");
  });

  test("finds .yml files", () => {
    fs.writeFileSync(path.join(tmpDir, "wf.yml"), "name: test");
    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("wf.yml");
  });

  test("finds all supported formats together", () => {
    fs.writeFileSync(path.join(tmpDir, "a.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "b.yaml"), "name: test");
    fs.writeFileSync(path.join(tmpDir, "c.yml"), "name: test");
    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(3);
  });

  test("ignores non-workflow files", () => {
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello");
    fs.writeFileSync(path.join(tmpDir, "script.js"), "console.log()");
    fs.writeFileSync(path.join(tmpDir, "data.csv"), "a,b,c");
    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(0);
  });

  test("skips _subfiles directory", () => {
    const subfilesDir = path.join(tmpDir, "_subfiles");
    fs.mkdirSync(subfilesDir);
    fs.writeFileSync(path.join(subfilesDir, "code.json"), "{}");
    fs.writeFileSync(path.join(subfilesDir, "query.yaml"), "name: test");

    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(0);
  });

  test("scans subdirectories recursively but skips _subfiles", () => {
    const subDir = path.join(tmpDir, "team");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "wf.json"), "{}");

    const subfilesDir = path.join(tmpDir, "_subfiles");
    fs.mkdirSync(subfilesDir);
    fs.writeFileSync(path.join(subfilesDir, "skip.json"), "{}");

    const files = scanFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("team");
  });
});

describe("loadLintFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-load-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads a JSON file", async () => {
    const wf = { id: "j1", name: "JSON WF", nodes: [], connections: {} };
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(wf));

    const result = await loadLintFile(filePath);
    expect(result.workflow).not.toBeNull();
    expect(result.workflow!.name).toBe("JSON WF");
    expect(result.rawJSON).toBe(JSON.stringify(wf));
  });

  test("loads a JSON file with invalid JSON - returns rawJSON with null workflow", async () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not valid json {{{");

    const result = await loadLintFile(filePath);
    expect(result.workflow).toBeNull();
    expect(result.rawJSON).toBe("not valid json {{{");
  });

  test("loads a YAML file", async () => {
    const filePath = path.join(tmpDir, "wf.yaml");
    fs.writeFileSync(
      filePath,
      "id: y1\nname: YAML WF\nactive: false\nnodes:\n  - id: n1\n    name: Node1\n    type: test\n    typeVersion: 1\n    position: [0, 0]\n    parameters: {}\nconnections: {}\n",
    );

    const result = await loadLintFile(filePath);
    expect(result.workflow).not.toBeNull();
    expect(result.workflow!.name).toBe("YAML WF");
    // rawJSON should be valid JSON produced from YAML parse
    const parsed = JSON.parse(result.rawJSON);
    expect(parsed.name).toBe("YAML WF");
  });

  test("loads a .yml file", async () => {
    const filePath = path.join(tmpDir, "wf.yml");
    fs.writeFileSync(
      filePath,
      "id: y2\nname: YML WF\nactive: false\nnodes:\n  - id: n1\n    name: Node1\n    type: test\n    typeVersion: 1\n    position: [0, 0]\n    parameters: {}\nconnections: {}\n",
    );

    const result = await loadLintFile(filePath);
    expect(result.workflow).not.toBeNull();
    expect(result.workflow!.name).toBe("YML WF");
  });

  test("throws on invalid YAML file", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(filePath, ":\n  :\n  - : :\n  invalid: [unclosed");

    await expect(loadLintFile(filePath)).rejects.toThrow("YAML parse error");
  });

  test("throws on nonexistent file", async () => {
    await expect(loadLintFile(path.join(tmpDir, "nope.json"))).rejects.toThrow();
  });

  test("throws on nonexistent YAML file", async () => {
    await expect(loadLintFile(path.join(tmpDir, "nope.yaml"))).rejects.toThrow();
  });
});

describe("loadLintFileWithoutIncludes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-noinc-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns tags and name from YAML with broken !include", async () => {
    const filePath = path.join(tmpDir, "wf.yaml");
    const yamlContent = [
      "id: wf1",
      "name: Tagged Workflow",
      "active: false",
      "tags:",
      "  - id: t1",
      "    name: managed-as-code",
      "nodes:",
      "  - id: n1",
      "    name: Node1",
      "    type: test",
      "    typeVersion: 1",
      "    position: [0, 0]",
      "    parameters:",
      "      code: !include nonexistent-file.js",
      "connections: {}",
    ].join("\n");
    fs.writeFileSync(filePath, yamlContent);

    // loadLintFile should throw because !include target does not exist
    await expect(loadLintFile(filePath)).rejects.toThrow();

    // loadLintFileWithoutIncludes should succeed and return tags
    const result = await loadLintFileWithoutIncludes(filePath);
    expect(result.workflow).not.toBeNull();
    expect(result.workflow!.name).toBe("Tagged Workflow");
    expect(result.workflow!.tags).toHaveLength(1);
    expect(result.workflow!.tags![0]!.name).toBe("managed-as-code");
  });

  test("works the same as loadLintFile for JSON files", async () => {
    const wf = { id: "j1", name: "JSON WF", nodes: [], connections: {} };
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(wf));

    const result = await loadLintFileWithoutIncludes(filePath);
    expect(result.workflow).not.toBeNull();
    expect(result.workflow!.name).toBe("JSON WF");
  });
});
