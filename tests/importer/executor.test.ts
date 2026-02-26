import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { ImportExecutor } from "@/importer/executor.ts";
import { defaultImportOptions, type ImportOptions } from "@/importer/types.ts";

/** Creates a minimal Workflow object for testing. */
function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf1",
    name: "Test Workflow",
    active: false,
    nodes: [],
    connections: {},
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Creates a mock WorkflowService that returns the given workflows. */
function mockService(workflows: Workflow[]): WorkflowService {
  return {
    listWorkflows: async () => ({
      data: workflows,
      nextCursor: undefined,
    }),
  } as unknown as WorkflowService;
}

describe("ImportExecutor rename", () => {
  let tmpDir: string;
  let opts: ImportOptions;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-test-"));
    opts = {
      ...defaultImportOptions(),
      directory: tmpDir,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("renames existing file when filename does not match current naming rules", async () => {
    // Create a local file with an "old" naming convention
    const oldFilename = "Old Name__wf1.json";
    const oldPath = path.join(tmpDir, oldFilename);
    const localWf = {
      id: "wf1",
      name: "Test Workflow",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(oldPath, JSON.stringify(localWf, null, 2));

    const remote = makeWorkflow({
      id: "wf1",
      name: "Test Workflow",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const executor = new ImportExecutor(mockService([remote]), opts);
    const result = await executor.execute();

    // The old file should be deleted
    expect(fs.existsSync(oldPath)).toBe(false);

    // A new file with current naming rules should exist
    const expectedFilename = "test-workflow__wf1.json";
    const expectedPath = path.join(tmpDir, expectedFilename);
    expect(fs.existsSync(expectedPath)).toBe(true);

    // The operation should be recorded as rename
    expect(result.renamed).toBe(1);
    const renameOp = result.operations.find((op) => op.type === "rename");
    expect(renameOp).toBeDefined();
    expect(renameOp!.oldPath).toBe(oldPath);
    expect(renameOp!.localPath).toBe(expectedPath);
  });

  test("updates existing file normally when filename matches current naming rules", async () => {
    // Create a local file that already uses the correct naming convention
    const correctFilename = "test-workflow__wf1.json";
    const correctPath = path.join(tmpDir, correctFilename);
    const localWf = {
      id: "wf1",
      name: "Test Workflow",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(correctPath, JSON.stringify(localWf, null, 2));

    const remote = makeWorkflow({
      id: "wf1",
      name: "Test Workflow",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const executor = new ImportExecutor(mockService([remote]), opts);
    const result = await executor.execute();

    // File should still exist at the same path
    expect(fs.existsSync(correctPath)).toBe(true);

    // Should be recorded as update, not rename
    expect(result.updated).toBe(1);
    expect(result.renamed).toBe(0);
  });

  test("deletes old _subfiles directory when renaming", async () => {
    // Create old file and old _subfiles directory
    const oldFilename = "Old Name__wf1.json";
    const oldPath = path.join(tmpDir, oldFilename);
    const localWf = {
      id: "wf1",
      name: "Test Workflow",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(oldPath, JSON.stringify(localWf, null, 2));

    // Create an old _subfiles directory with matching ID but different name
    const oldSubfilesDir = path.join(tmpDir, "_subfiles", "old-name__wf1");
    fs.mkdirSync(oldSubfilesDir, { recursive: true });
    fs.writeFileSync(path.join(oldSubfilesDir, "some-file.txt"), "test content");

    const remote = makeWorkflow({
      id: "wf1",
      name: "Test Workflow",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const executor = new ImportExecutor(mockService([remote]), opts);
    await executor.execute();

    // The old _subfiles directory should be deleted
    expect(fs.existsSync(oldSubfilesDir)).toBe(false);
  });

  test("reports Would rename in dry-run mode", async () => {
    opts.dryRun = true;

    const oldFilename = "Old Name__wf1.json";
    const oldPath = path.join(tmpDir, oldFilename);
    const localWf = {
      id: "wf1",
      name: "Test Workflow",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(oldPath, JSON.stringify(localWf, null, 2));

    const remote = makeWorkflow({
      id: "wf1",
      name: "Test Workflow",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const executor = new ImportExecutor(mockService([remote]), opts);
    const result = await executor.execute();

    // In dry-run, old file should still exist
    expect(fs.existsSync(oldPath)).toBe(true);

    // Should be recorded as rename
    expect(result.renamed).toBe(1);
    const renameOp = result.operations.find((op) => op.type === "rename");
    expect(renameOp).toBeDefined();
    expect(renameOp!.oldPath).toBe(oldPath);
  });

  test("deletes all old _subfiles directories when multiple exist for same ID", async () => {
    const oldFilename = "Old Name__wf1.json";
    const oldPath = path.join(tmpDir, oldFilename);
    const localWf = {
      id: "wf1",
      name: "Test Workflow",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(oldPath, JSON.stringify(localWf, null, 2));

    // Create two old _subfiles directories with matching ID but different names
    const oldSubfilesDir1 = path.join(tmpDir, "_subfiles", "old-name__wf1");
    const oldSubfilesDir2 = path.join(tmpDir, "_subfiles", "another-old-name__wf1");
    fs.mkdirSync(oldSubfilesDir1, { recursive: true });
    fs.mkdirSync(oldSubfilesDir2, { recursive: true });
    fs.writeFileSync(path.join(oldSubfilesDir1, "file1.txt"), "content1");
    fs.writeFileSync(path.join(oldSubfilesDir2, "file2.txt"), "content2");

    const remote = makeWorkflow({
      id: "wf1",
      name: "Test Workflow",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const executor = new ImportExecutor(mockService([remote]), opts);
    await executor.execute();

    // Both old _subfiles directories should be deleted
    expect(fs.existsSync(oldSubfilesDir1)).toBe(false);
    expect(fs.existsSync(oldSubfilesDir2)).toBe(false);
  });

  test("old file is deleted after rename", async () => {
    const oldFilename = "Something Else__wf1.json";
    const oldPath = path.join(tmpDir, oldFilename);
    const localWf = {
      id: "wf1",
      name: "Test Workflow",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(oldPath, JSON.stringify(localWf, null, 2));

    const remote = makeWorkflow({
      id: "wf1",
      name: "Test Workflow",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const executor = new ImportExecutor(mockService([remote]), opts);
    await executor.execute();

    // Old file must not exist
    expect(fs.existsSync(oldPath)).toBe(false);

    // New file must exist
    const expectedPath = path.join(tmpDir, "test-workflow__wf1.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    // New file should contain correct content
    const content = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
    expect(content.id).toBe("wf1");
    expect(content.name).toBe("Test Workflow");
  });
});
