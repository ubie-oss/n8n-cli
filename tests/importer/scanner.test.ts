import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowFile, scanDirectory, scanDirectoryWithOrphans } from "@/importer/scanner.ts";

describe("scanDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty map for nonexistent directory", () => {
    const idMap = scanDirectory(path.join(tmpDir, "nonexistent"));
    expect(idMap.count()).toBe(0);
  });

  test("scans JSON files and extracts IDs", () => {
    const wf = { id: "abc123", name: "Test WF", nodes: [], connections: {} };
    fs.writeFileSync(path.join(tmpDir, "test__abc123.json"), JSON.stringify(wf));

    const idMap = scanDirectory(tmpDir);
    expect(idMap.count()).toBe(1);
    const [filePath, found] = idMap.get("abc123");
    expect(found).toBe(true);
    expect(filePath).toContain("test__abc123.json");
  });

  test("scans subdirectories recursively", () => {
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);

    const wf = { id: "sub123", name: "Sub WF", nodes: [], connections: {} };
    fs.writeFileSync(path.join(subDir, "wf__sub123.json"), JSON.stringify(wf));

    const idMap = scanDirectory(tmpDir);
    expect(idMap.count()).toBe(1);
    const [, found] = idMap.get("sub123");
    expect(found).toBe(true);
  });

  test("skips _subfiles directory", () => {
    const subfilesDir = path.join(tmpDir, "_subfiles");
    fs.mkdirSync(subfilesDir);

    const wf = { id: "skip123", name: "Skip", nodes: [], connections: {} };
    fs.writeFileSync(path.join(subfilesDir, "wf__skip123.json"), JSON.stringify(wf));

    const idMap = scanDirectory(tmpDir);
    expect(idMap.count()).toBe(0);
  });

  test("detects duplicate IDs", () => {
    const wf1 = { id: "dup123", name: "WF1", nodes: [], connections: {} };
    const wf2 = { id: "dup123", name: "WF2", nodes: [], connections: {} };
    fs.writeFileSync(path.join(tmpDir, "wf1__dup123.json"), JSON.stringify(wf1));
    fs.writeFileSync(path.join(tmpDir, "wf2__dup123.json"), JSON.stringify(wf2));

    const idMap = scanDirectory(tmpDir);
    expect(idMap.hasDuplicates()).toBe(true);
    expect(idMap.duplicates().has("dup123")).toBe(true);
  });

  test("skips invalid JSON files silently", () => {
    fs.writeFileSync(path.join(tmpDir, "invalid__xxx.json"), "not json");
    const wf = { id: "good123", name: "Good", nodes: [], connections: {} };
    fs.writeFileSync(path.join(tmpDir, "good__good123.json"), JSON.stringify(wf));

    const idMap = scanDirectory(tmpDir);
    expect(idMap.count()).toBe(1);
    const [, found] = idMap.get("good123");
    expect(found).toBe(true);
  });

  test("skips JSON files without ID", () => {
    const wf = { name: "No ID", nodes: [], connections: {} };
    fs.writeFileSync(path.join(tmpDir, "no-id.json"), JSON.stringify(wf));

    const idMap = scanDirectory(tmpDir);
    expect(idMap.count()).toBe(0);
  });

  test("scans YAML files with numeric ID", () => {
    const yamlContent = "id: 91\nname: Numeric ID WF\nnodes: []\nconnections: {}\n";
    fs.writeFileSync(path.join(tmpDir, "numeric-id-wf__91.yaml"), yamlContent);

    const idMap = scanDirectory(tmpDir);
    expect(idMap.count()).toBe(1);
    const [filePath, found] = idMap.get("91");
    expect(found).toBe(true);
    expect(filePath).toContain("numeric-id-wf__91.yaml");
  });
});

describe("scanDirectoryWithOrphans", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("separates files with IDs from orphans", () => {
    const withID = { id: "has123", name: "Has ID", nodes: [], connections: {} };
    const withoutID = { name: "No ID WF", nodes: [], connections: {} };

    fs.writeFileSync(path.join(tmpDir, "has__has123.json"), JSON.stringify(withID));
    fs.writeFileSync(path.join(tmpDir, "orphan.json"), JSON.stringify(withoutID));

    const [idMap, orphanMap] = scanDirectoryWithOrphans(tmpDir);
    expect(idMap.count()).toBe(1);
    expect(orphanMap.count()).toBe(1);
    expect(orphanMap.getByName("No ID WF")).toHaveLength(1);
  });

  test("returns empty maps for nonexistent directory", () => {
    const [idMap, orphanMap] = scanDirectoryWithOrphans(path.join(tmpDir, "nonexistent"));
    expect(idMap.count()).toBe(0);
    expect(orphanMap.count()).toBe(0);
  });

  test("handles YAML files with numeric ID correctly", () => {
    const yamlContent = "id: 42\nname: Numeric WF\nnodes: []\nconnections: {}\n";
    fs.writeFileSync(path.join(tmpDir, "numeric-wf__42.yaml"), yamlContent);

    const [idMap, orphanMap] = scanDirectoryWithOrphans(tmpDir);
    expect(idMap.count()).toBe(1);
    const [, found] = idMap.get("42");
    expect(found).toBe(true);
    expect(orphanMap.count()).toBe(0);
  });
});

describe("parseWorkflowFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses a valid JSON workflow file", () => {
    const wf = {
      id: "parse123",
      name: "Parse Test",
      active: true,
      nodes: [{ id: "n1", name: "Node1", type: "test", typeVersion: 1, position: [0, 0] }],
      connections: {},
    };
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(wf));

    const parsed = parseWorkflowFile(filePath);
    expect(parsed.id).toBe("parse123");
    expect(parsed.name).toBe("Parse Test");
    expect(parsed.nodes).toHaveLength(1);
  });

  test("throws on nonexistent file", () => {
    expect(() => parseWorkflowFile("/nonexistent.json")).toThrow();
  });
});
