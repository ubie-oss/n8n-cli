import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FolderService } from "@/api/folder-service.ts";
import type { Folder, FolderInput, Workflow, WorkflowInput } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { compare } from "@/apply/differ.ts";
import { Executor } from "@/apply/executor.ts";
import { defaultApplyOptions } from "@/apply/types.ts";

/**
 * The two workflow fields the n8n public API gained: `description`, which is
 * read and written like any other field, and `parentFolderId`, which is
 * write-only and therefore has no remote state to compare against.
 *
 * The behaviour worth pinning is what happens when a definition says *nothing*
 * about either. Every workflow file written before this feature existed omits
 * both, and an apply that read those omissions as "clear the description" or
 * "move to the project root" would quietly undo work done in the n8n UI across
 * an entire repository on its next run.
 */

interface Recorded {
  creates: WorkflowInput[];
  updates: WorkflowInput[];
}

function mockService(remote: Workflow | null): {
  service: WorkflowService;
  recorded: Recorded;
} {
  const recorded: Recorded = { creates: [], updates: [] };
  const service = {
    listAllWorkflows: async () => (remote ? [remote] : []),
    getWorkflow: async () => {
      if (!remote) throw Object.assign(new Error("not found"), { name: "APIError" });
      return remote;
    },
    createWorkflow: async (input: WorkflowInput) => {
      recorded.creates.push(input);
      return { ...input, id: "wf1", updatedAt: "2026-04-01T00:00:00.000Z" } as unknown as Workflow;
    },
    updateWorkflow: async (_id: string, input: WorkflowInput) => {
      recorded.updates.push(input);
      return { ...remote, ...input, updatedAt: "2026-04-01T00:00:00.000Z" } as unknown as Workflow;
    },
    getWorkflowCurrentProjectID: () => "",
  } as unknown as WorkflowService;
  return { service, recorded };
}

class FakeFolderService {
  readonly created: FolderInput[] = [];
  constructor(private folders: Folder[] = []) {}
  async listAllFolders(): Promise<Folder[]> {
    return this.folders;
  }
  async createFolder(_p: string, input: FolderInput): Promise<Folder> {
    this.created.push(input);
    const folder = { id: `id-${this.created.length}`, name: input.name };
    this.folders.push(folder);
    return folder;
  }
  asService(): FolderService {
    return this as unknown as FolderService;
  }
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-desc-folder-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeDefinition(body: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, "wf__wf1.json"),
    `${JSON.stringify({ nodes: [], connections: {}, active: false, ...body }, null, 2)}\n`,
  );
}

function executor(service: WorkflowService, folders?: FakeFolderService): Executor {
  const opts = defaultApplyOptions();
  opts.directory = dir;
  opts.all = true;
  opts.noLint = true;
  opts.allowDuplicates = true;
  const ex = new Executor(service, opts);
  if (folders) ex.setFolderService(folders.asService());
  return ex;
}

describe("description diffing", () => {
  const base: Workflow = { id: "wf1", name: "wf", active: false, nodes: [], connections: {} };

  test("a definition without a description reports no description change", () => {
    const diff = compare(base, { ...base, description: "written in the UI" });
    expect(diff.fields.map((f) => f.field)).not.toContain("description");
  });

  test("a differing description is a change", () => {
    const diff = compare({ ...base, description: "new" }, { ...base, description: "old" });
    expect(diff.fields).toContainEqual({
      field: "description",
      oldValue: "old",
      newValue: "new",
    });
  });

  test("an identical description is not a change", () => {
    const diff = compare({ ...base, description: "same" }, { ...base, description: "same" });
    expect(diff.hasChanges).toBe(false);
  });

  test("an explicit empty description clears a remote one", () => {
    const diff = compare({ ...base, description: "" }, { ...base, description: "old" });
    expect(diff.hasChanges).toBe(true);
  });

  test("an explicit empty description against no remote one is not a change", () => {
    const diff = compare({ ...base, description: "" }, base);
    expect(diff.hasChanges).toBe(false);
  });
});

describe("description on write", () => {
  test("is omitted from the payload when the definition has none", async () => {
    const remote: Workflow = {
      id: "wf1",
      name: "old",
      active: false,
      nodes: [],
      connections: {},
      description: "written in the UI",
    };
    const { service, recorded } = mockService(remote);
    writeDefinition({ id: "wf1", name: "renamed" });

    await executor(service).execute();

    expect(recorded.updates).toHaveLength(1);
    // The key must be absent, not empty: n8n reads an absent key as "leave it".
    expect("description" in recorded.updates[0]!).toBe(false);
  });

  test("is sent when the definition declares one", async () => {
    const remote: Workflow = { id: "wf1", name: "wf", active: false, nodes: [], connections: {} };
    const { service, recorded } = mockService(remote);
    writeDefinition({ id: "wf1", name: "wf", description: "managed as code" });

    await executor(service).execute();

    expect(recorded.updates[0]?.description).toBe("managed as code");
  });

  test("is sent on create", async () => {
    const { service, recorded } = mockService(null);
    writeDefinition({ name: "fresh", description: "hello" });

    await executor(service).execute();

    expect(recorded.creates[0]?.description).toBe("hello");
  });
});

describe("folder placement on write", () => {
  test("sends no parentFolderId when the definition declares no folder", async () => {
    const { service, recorded } = mockService(null);
    const folders = new FakeFolderService();
    writeDefinition({ name: "fresh" });

    await executor(service, folders).execute();

    // Sending null here would yank every existing workflow out of its folder.
    expect("parentFolderId" in recorded.creates[0]!).toBe(false);
    expect(folders.created).toEqual([]);
  });

  test("resolves a folderPath into the folder's ID", async () => {
    const { service, recorded } = mockService(null);
    const folders = new FakeFolderService([{ id: "f1", name: "Ops" }]);
    writeDefinition({ name: "fresh", folderPath: "Ops" });

    await executor(service, folders).execute();

    expect(recorded.creates[0]?.parentFolderId).toBe("f1");
  });

  test("sends null for a definition that asks for the project root", async () => {
    const { service, recorded } = mockService(null);
    writeDefinition({ name: "fresh", folderPath: "" });

    await executor(service, new FakeFolderService()).execute();

    expect(recorded.creates[0]?.parentFolderId).toBeNull();
  });

  test("prefers an explicit folderId over a path lookup", async () => {
    const { service, recorded } = mockService(null);
    const folders = new FakeFolderService([{ id: "f1", name: "Ops" }]);
    writeDefinition({ name: "fresh", folderId: "explicit", folderPath: "Ops" });

    await executor(service, folders).execute();

    expect(recorded.creates[0]?.parentFolderId).toBe("explicit");
  });

  test("fails the workflow, not the run, when the folder cannot be resolved", async () => {
    const { service, recorded } = mockService(null);
    const opts = defaultApplyOptions();
    opts.directory = dir;
    opts.all = true;
    opts.noLint = true;
    opts.allowDuplicates = true;
    opts.noCreateFolders = true;
    const ex = new Executor(service, opts);
    ex.setFolderService(new FakeFolderService().asService());
    writeDefinition({ name: "fresh", folderPath: "Missing" });

    const result = await ex.execute();

    expect(result.errorCount).toBe(1);
    expect(result.operations[0]?.error?.message).toMatch(/does not exist/);
    // Nothing was written upstream: the placement is part of the write, not a
    // follow-up call that could leave a workflow in the wrong folder.
    expect(recorded.creates).toEqual([]);
  });

  test("reports an error rather than throwing when no folder service is wired", async () => {
    const { service } = mockService(null);
    writeDefinition({ name: "fresh", folderPath: "Ops" });

    const result = await executor(service).execute();

    expect(result.errorCount).toBe(1);
    expect(result.operations[0]?.error?.message).toMatch(/no folder service/);
  });
});
