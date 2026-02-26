import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import {
  embedWorkflowID,
  findExistingSubfilesDir,
  findExistingSubfilesDirs,
  generateFilePath,
  generateYamlFilePath,
  sanitizeFilename,
  writeWorkflowJSON,
} from "@/importer/writer.ts";

describe("sanitizeFilename", () => {
  test("basic name", () => {
    expect(sanitizeFilename("My Workflow")).toBe("my-workflow");
  });

  test("replaces special characters", () => {
    expect(sanitizeFilename("A & B")).toBe("a-and-b");
  });

  test("removes invalid characters", () => {
    expect(sanitizeFilename("Test*File?")).toBe("testfile");
  });

  test("handles Japanese characters", () => {
    const result = sanitizeFilename("日次レポート");
    expect(result).toBe("日次レポート");
  });

  test("replaces separator characters", () => {
    expect(sanitizeFilename("A/B:C")).toBe("a-b-c");
  });

  test("compresses consecutive hyphens", () => {
    expect(sanitizeFilename("A  B   C")).toBe("a-b-c");
  });

  test("trims leading/trailing hyphens", () => {
    expect(sanitizeFilename(" test ")).toBe("test");
  });

  test("handles empty string", () => {
    expect(sanitizeFilename("")).toBe("unnamed");
  });

  test("handles arrow character", () => {
    expect(sanitizeFilename("A→B")).toBe("a-b");
  });

  test("handles parentheses", () => {
    expect(sanitizeFilename("A（B）")).toBe("a-b");
  });

  test("lowercases", () => {
    expect(sanitizeFilename("MyWorkflow")).toBe("myworkflow");
  });
});

describe("generateFilePath", () => {
  test("generates correct JSON path", () => {
    const p = generateFilePath("defs", "abc123", "テスト WF");
    expect(p).toBe(path.join("defs", "テスト-wf__abc123.json"));
  });
});

describe("generateYamlFilePath", () => {
  test("generates correct YAML path", () => {
    const p = generateYamlFilePath("defs", "abc123", "テスト WF");
    expect(p).toBe(path.join("defs", "テスト-wf__abc123.yaml"));
  });
});

describe("writeWorkflowJSON", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes formatted JSON with trailing newline", () => {
    const wf: Workflow = {
      id: "wf1",
      name: "Test",
      active: false,
      nodes: [],
      connections: {},
    };
    const filePath = path.join(tmpDir, "test.json");
    writeWorkflowJSON(filePath, wf);

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain('"id": "wf1"');
    expect(content).toContain('"name": "Test"');
    expect(content.endsWith("\n")).toBe(true);

    // Verify it's valid JSON
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("wf1");
  });

  test("creates parent directories", () => {
    const wf: Workflow = {
      id: "wf2",
      name: "Nested",
      active: false,
      nodes: [],
      connections: {},
    };
    const filePath = path.join(tmpDir, "sub", "dir", "test.json");
    writeWorkflowJSON(filePath, wf);

    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe("embedWorkflowID", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("embeds ID into JSON file without existing ID", () => {
    const wf = { name: "Test", nodes: [], connections: {} };
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(wf, null, 2));

    embedWorkflowID(filePath, "new-id-123");

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("new-id-123");
    expect(parsed.name).toBe("Test");
  });

  test("throws if ID already exists", () => {
    const wf = { id: "existing", name: "Test", nodes: [], connections: {} };
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(wf, null, 2));

    expect(() => embedWorkflowID(filePath, "new-id")).toThrow("ID already exists");
  });

  test("allows embedding if ID field is empty string", () => {
    const wf = { id: "", name: "Test", nodes: [], connections: {} };
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(wf, null, 2));

    embedWorkflowID(filePath, "new-id");

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.id).toBe("new-id");
  });
});

describe("findExistingSubfilesDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subfiles-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds existing subfiles directory by workflow ID", () => {
    const subfilesDir = path.join(tmpDir, "_subfiles", "old-name__wf123");
    fs.mkdirSync(subfilesDir, { recursive: true });

    const result = findExistingSubfilesDir(tmpDir, "wf123");
    expect(result).toBe(subfilesDir);
  });

  test("returns null when no matching directory exists", () => {
    const subfilesDir = path.join(tmpDir, "_subfiles", "some-name__wf999");
    fs.mkdirSync(subfilesDir, { recursive: true });

    const result = findExistingSubfilesDir(tmpDir, "wf000");
    expect(result).toBeNull();
  });

  test("returns null when _subfiles directory does not exist", () => {
    const result = findExistingSubfilesDir(tmpDir, "wf123");
    expect(result).toBeNull();
  });
});

describe("findExistingSubfilesDirs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subfiles-dirs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns all matching directories for same workflow ID", () => {
    const dir1 = path.join(tmpDir, "_subfiles", "old-name__wf123");
    const dir2 = path.join(tmpDir, "_subfiles", "new-name__wf123");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const result = findExistingSubfilesDirs(tmpDir, "wf123");
    expect(result).toHaveLength(2);
    expect(result).toContain(dir1);
    expect(result).toContain(dir2);
  });

  test("returns empty array when no matching directory exists", () => {
    const dir = path.join(tmpDir, "_subfiles", "some-name__wf999");
    fs.mkdirSync(dir, { recursive: true });

    const result = findExistingSubfilesDirs(tmpDir, "wf000");
    expect(result).toHaveLength(0);
  });

  test("returns empty array when _subfiles directory does not exist", () => {
    const result = findExistingSubfilesDirs(tmpDir, "wf123");
    expect(result).toHaveLength(0);
  });

  test("returns single directory when only one matches", () => {
    const dir = path.join(tmpDir, "_subfiles", "my-wf__wf456");
    fs.mkdirSync(dir, { recursive: true });

    const result = findExistingSubfilesDirs(tmpDir, "wf456");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(dir);
  });
});
