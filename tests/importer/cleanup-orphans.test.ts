import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { ImportExecutor } from "@/importer/executor.ts";
import { defaultImportOptions, type ImportOptions } from "@/importer/types.ts";
import { getSubfilesDir } from "@/importer/writer.ts";

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

describe("ImportExecutor --cleanup-orphans (deleted-remotely files)", () => {
  let tmpDir: string;
  let opts: ImportOptions;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-orphans-test-"));
    opts = {
      ...defaultImportOptions(),
      directory: tmpDir,
      cleanupOrphans: true,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Writes a local workflow file with an embedded ID, as import would. */
  function writeLocalFile(id: string, name: string): string {
    const filename = `${name.toLowerCase().replace(/\s+/g, "-")}__${id}.json`;
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          id,
          name,
          active: false,
          nodes: [],
          connections: {},
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
    );
    return filePath;
  }

  test("deletes local file whose workflow was removed from n8n", async () => {
    const stalePath = writeLocalFile("wf-deleted", "Deleted Workflow");

    const executor = new ImportExecutor(mockService([]), opts);
    const result = await executor.execute();

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(result.cleanedUp).toBe(1);
    const op = result.operations.find((o) => o.localPath === stalePath);
    expect(op?.type).toBe("cleanup");
  });

  test("keeps local file when the workflow still exists remotely", async () => {
    const keptPath = writeLocalFile("wf1", "Test Workflow");
    const remote = makeWorkflow({ id: "wf1", name: "Test Workflow" });

    const executor = new ImportExecutor(mockService([remote]), opts);
    await executor.execute();

    expect(fs.existsSync(keptPath)).toBe(true);
  });

  test("keeps local file for an archived workflow (not deleted, just filtered)", async () => {
    const keptPath = writeLocalFile("wf1", "Test Workflow");
    const remote = makeWorkflow({ id: "wf1", name: "Test Workflow", isArchived: true });

    const executor = new ImportExecutor(mockService([remote]), opts);
    await executor.execute();

    expect(fs.existsSync(keptPath)).toBe(true);
  });

  test("dry-run reports but does not delete stale files", async () => {
    const stalePath = writeLocalFile("wf-deleted", "Deleted Workflow");

    const executor = new ImportExecutor(mockService([]), { ...opts, dryRun: true });
    const result = await executor.execute();

    expect(fs.existsSync(stalePath)).toBe(true);
    expect(result.cleanedUp).toBe(1);
  });

  test("without --cleanup-orphans, stale files are left alone", async () => {
    const stalePath = writeLocalFile("wf-deleted", "Deleted Workflow");

    const executor = new ImportExecutor(mockService([]), { ...opts, cleanupOrphans: false });
    await executor.execute();

    expect(fs.existsSync(stalePath)).toBe(true);
  });

  test("with --ids scope, only stale files within that scope are deleted", async () => {
    const staleInScope = writeLocalFile("wf-deleted", "Deleted Workflow");
    const staleOutOfScope = writeLocalFile("wf-other", "Other Workflow");

    const executor = new ImportExecutor(mockService([]), {
      ...opts,
      ids: ["wf-deleted"],
    });
    await executor.execute();

    expect(fs.existsSync(staleInScope)).toBe(false);
    expect(fs.existsSync(staleOutOfScope)).toBe(true);
  });

  test("--cleanup-orphans alone deletes the workflow file but leaves its _subfiles directory", async () => {
    const stalePath = writeLocalFile("wf-deleted", "Deleted Workflow");
    const subfilesDir = getSubfilesDir(tmpDir, "wf-deleted", "Deleted Workflow");
    fs.mkdirSync(subfilesDir, { recursive: true });
    fs.writeFileSync(path.join(subfilesDir, "code.js"), "// external code");

    const executor = new ImportExecutor(mockService([]), opts);
    await executor.execute();

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(subfilesDir)).toBe(true);
  });

  test("--cleanup-orphans + --cleanup-subfiles deletes both the workflow file and its _subfiles directory", async () => {
    const stalePath = writeLocalFile("wf-deleted", "Deleted Workflow");
    const subfilesDir = getSubfilesDir(tmpDir, "wf-deleted", "Deleted Workflow");
    fs.mkdirSync(subfilesDir, { recursive: true });
    fs.writeFileSync(path.join(subfilesDir, "code.js"), "// external code");

    const executor = new ImportExecutor(mockService([]), { ...opts, cleanupSubfiles: true });
    const result = await executor.execute();

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(subfilesDir)).toBe(false);
    const dirOp = result.operations.find((o) => o.localPath === subfilesDir);
    expect(dirOp?.type).toBe("cleanup");
  });

  test("dry-run reports but does not delete the stale workflow's _subfiles directory", async () => {
    writeLocalFile("wf-deleted", "Deleted Workflow");
    const subfilesDir = getSubfilesDir(tmpDir, "wf-deleted", "Deleted Workflow");
    fs.mkdirSync(subfilesDir, { recursive: true });
    fs.writeFileSync(path.join(subfilesDir, "code.js"), "// external code");

    const executor = new ImportExecutor(mockService([]), {
      ...opts,
      cleanupSubfiles: true,
      dryRun: true,
    });
    const result = await executor.execute();

    expect(fs.existsSync(subfilesDir)).toBe(true);
    const dirOp = result.operations.find((o) => o.localPath === subfilesDir);
    expect(dirOp?.type).toBe("cleanup");
  });

  test("keeps the _subfiles directory when the workflow still exists remotely", async () => {
    writeLocalFile("wf1", "Test Workflow");
    const subfilesDir = getSubfilesDir(tmpDir, "wf1", "Test Workflow");
    fs.mkdirSync(subfilesDir, { recursive: true });
    fs.writeFileSync(path.join(subfilesDir, "code.js"), "// external code");

    const remote = makeWorkflow({ id: "wf1", name: "Test Workflow" });
    const executor = new ImportExecutor(mockService([remote]), { ...opts, cleanupSubfiles: true });
    await executor.execute();

    expect(fs.existsSync(subfilesDir)).toBe(true);
  });

  test("--cleanup-subfiles alone removes a pre-existing orphan _subfiles directory with no matching local file", async () => {
    // Simulates a directory left behind by manual deletion or an older
    // n8n-cli version that didn't clean up _subfiles — no local workflow
    // file ever existed for this ID in this run, so --cleanup-orphans is
    // irrelevant here; --cleanup-subfiles alone must catch it.
    const subfilesDir = getSubfilesDir(tmpDir, "wf-long-gone", "Long Gone Workflow");
    fs.mkdirSync(subfilesDir, { recursive: true });
    fs.writeFileSync(path.join(subfilesDir, "code.js"), "// external code");

    const executor = new ImportExecutor(mockService([]), {
      ...opts,
      cleanupOrphans: false,
      cleanupSubfiles: true,
    });
    await executor.execute();

    expect(fs.existsSync(subfilesDir)).toBe(false);
  });
});
