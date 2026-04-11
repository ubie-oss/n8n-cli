import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { type ConvertOptions, convertWorkflowFile, detectFormat } from "@/convert/converter.ts";

const tmpBase = path.join(import.meta.dirname, "__tmp_convert_test__");

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "wf-100",
    name: "Test Workflow",
    active: true,
    nodes: [
      {
        id: "node-1",
        name: "Start",
        type: "n8n-nodes-base.start",
        typeVersion: 1,
        position: [0, 0] as [number, number],
      },
    ],
    connections: {},
    ...overrides,
  };
}

function writeJSON(dir: string, filename: string, workflow: Workflow): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2));
  return filePath;
}

function writeYAML(dir: string, filename: string, workflow: Workflow): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  // Simple YAML serialization sufficient for tests
  const yaml = require("js-yaml") as typeof import("js-yaml");
  fs.writeFileSync(filePath, yaml.dump(workflow));
  return filePath;
}

function defaultOptions(overrides?: Partial<ConvertOptions>): ConvertOptions {
  return {
    targetFormat: "yaml",
    directory: tmpBase,
    externalizeThreshold: 3,
    dryRun: false,
    keepOriginal: false,
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("detectFormat", () => {
  test("returns json for .json files", () => {
    expect(detectFormat("workflow.json")).toBe("json");
  });

  test("returns yaml for .yaml files", () => {
    expect(detectFormat("workflow.yaml")).toBe("yaml");
  });

  test("returns yaml for .yml files", () => {
    expect(detectFormat("workflow.yml")).toBe("yaml");
  });

  test("returns null for unsupported extensions", () => {
    expect(detectFormat("workflow.txt")).toBeNull();
  });
});

describe("convertWorkflowFile", () => {
  test("converts JSON to YAML", () => {
    const wf = makeWorkflow();
    const jsonPath = writeJSON(tmpBase, "test__wf-100.json", wf);

    const result = convertWorkflowFile(jsonPath, defaultOptions());

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(false);
    expect(result.outputPath).toContain(".yaml");
    expect(result.writtenFiles.length).toBeGreaterThan(0);
    // Original JSON should be removed
    expect(fs.existsSync(jsonPath)).toBe(false);
    // YAML output should exist
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  test("converts YAML to JSON", () => {
    const wf = makeWorkflow();
    const yamlPath = writeYAML(tmpBase, "test__wf-100.yaml", wf);

    const result = convertWorkflowFile(yamlPath, defaultOptions({ targetFormat: "json" }));

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(false);
    expect(result.outputPath).toContain(".json");
    // Original YAML should be removed
    expect(fs.existsSync(yamlPath)).toBe(false);
    // JSON output should exist
    expect(fs.existsSync(result.outputPath)).toBe(true);
    // Verify it's valid JSON
    const content = fs.readFileSync(result.outputPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("wf-100");
    expect(parsed.name).toBe("Test Workflow");
  });

  test("skips when source format matches target format", () => {
    const wf = makeWorkflow();
    const jsonPath = writeJSON(tmpBase, "test__wf-100.json", wf);

    const result = convertWorkflowFile(jsonPath, defaultOptions({ targetFormat: "json" }));

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("already in json format");
    // File should still exist
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  test("skips unsupported file extensions", () => {
    const filePath = path.join(tmpBase, "workflow.txt");
    fs.writeFileSync(filePath, "not a workflow");

    const result = convertWorkflowFile(filePath, defaultOptions());

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("unsupported file extension");
  });

  test("errors on workflow without ID", () => {
    const wf = makeWorkflow({ id: undefined });
    const jsonPath = writeJSON(tmpBase, "test.json", wf);

    const result = convertWorkflowFile(jsonPath, defaultOptions());

    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("workflow has no ID");
  });

  test("dry-run does not write or remove files", () => {
    const wf = makeWorkflow();
    const jsonPath = writeJSON(tmpBase, "test__wf-100.json", wf);

    const result = convertWorkflowFile(jsonPath, defaultOptions({ dryRun: true }));

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(false);
    expect(result.outputPath).toContain(".yaml");
    expect(result.writtenFiles).toEqual([]);
    expect(result.removedFiles).toEqual([]);
    // Original should still exist
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  test("--keep preserves original file", () => {
    const wf = makeWorkflow();
    const jsonPath = writeJSON(tmpBase, "test__wf-100.json", wf);

    const result = convertWorkflowFile(jsonPath, defaultOptions({ keepOriginal: true }));

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBe(false);
    expect(result.removedFiles).toEqual([]);
    // Both files should exist
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  test("YAML to JSON cleans up _subfiles directory", () => {
    const wf = makeWorkflow();
    const yamlPath = writeYAML(tmpBase, "test__wf-100.yaml", wf);

    // Create a fake _subfiles directory
    const subfilesDir = path.join(tmpBase, "_subfiles", "test-workflow__wf-100");
    fs.mkdirSync(subfilesDir, { recursive: true });
    fs.writeFileSync(path.join(subfilesDir, "code.js"), "// code");

    const result = convertWorkflowFile(yamlPath, defaultOptions({ targetFormat: "json" }));

    expect(result.error).toBeUndefined();
    expect(result.removedFiles).toContain(subfilesDir);
    expect(fs.existsSync(subfilesDir)).toBe(false);
  });
});
