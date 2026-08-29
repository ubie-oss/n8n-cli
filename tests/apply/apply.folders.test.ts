import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "../../src/api/client.ts";
import { APIError, ErrorCode } from "../../src/api/errors.ts";
import { FolderService } from "../../src/api/folder-service.ts";
import type { Folder, Workflow, WorkflowInput } from "../../src/api/types.ts";
import type { WorkflowService } from "../../src/api/workflow-service.ts";
import { Executor } from "../../src/apply/executor.ts";
import { defaultApplyOptions } from "../../src/apply/types.ts";

/**
 * apply × folders end-to-end through the executor: folder declarations ride
 * workflow writes, the move is asserted even when content is unchanged, and
 * folder failures degrade to warnings (or errors under --strict-folders).
 * The folder REST surface is write-only upstream, so the mock services here
 * record what was *sent* rather than what could be read back.
 */

interface Recorded {
  creates: WorkflowInput[];
  updates: WorkflowInput[];
  moves: Array<{ id: string; parentFolderId: string | null }>;
  folderLists: number;
  folderCreates: Array<{ path: string; body: Record<string, unknown> }>;
}

function remoteWorkflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: "wf",
    active: false,
    nodes: [],
    connections: {},
    shared: [{ role: "workflow:owner", projectId: "p-remote" }],
    ...overrides,
  } as Workflow;
}

function buildServices(
  remote: Workflow | undefined,
  folders: Folder[] = [],
  opts: { rejectParentFolderIdOnCreate?: boolean; folderLicenseError?: boolean } = {},
): { service: WorkflowService; folderService: FolderService; recorded: Recorded } {
  const recorded: Recorded = {
    creates: [],
    updates: [],
    moves: [],
    folderLists: 0,
    folderCreates: [],
  };
  let createdSeq = 0;

  const service = {
    listAllWorkflows: async () => (remote ? [remote] : []),
    getWorkflow: async (id: string) => {
      if (remote && id === remote.id) return remote;
      throw new APIError(ErrorCode.NOT_FOUND, "Resource not found", 404);
    },
    createWorkflow: async (input: WorkflowInput, _projectId?: string) => {
      if (opts.rejectParentFolderIdOnCreate && "parentFolderId" in input) {
        throw new APIError(
          ErrorCode.VALIDATION_ERROR,
          "additional property parentFolderId is not allowed",
          400,
        );
      }
      recorded.creates.push(input);
      createdSeq++;
      const inputRecord = input as WorkflowInput & { id?: string };
      return {
        ...input,
        id: inputRecord.id ?? `new-${createdSeq}`,
        active: false,
      } as unknown as Workflow;
    },
    updateWorkflow: async (_id: string, input: WorkflowInput) => {
      recorded.updates.push(input);
      return { ...remote, ...input } as Workflow;
    },
    moveWorkflowToFolder: async (id: string, parentFolderId: string | null) => {
      recorded.moves.push({ id, parentFolderId });
      return remoteWorkflow(id);
    },
    transferWorkflow: async () => undefined,
    getWorkflowCurrentProjectID: (wf: Workflow | null) => wf?.shared?.[0]?.projectId ?? "",
  } as unknown as WorkflowService;

  const folderClient = {
    get: async (p: string) => {
      if (p.startsWith("/projects/")) {
        if (opts.folderLicenseError) {
          throw new APIError(
            ErrorCode.AUTH_ERROR,
            "License does not include the folders feature",
            403,
          );
        }
        recorded.folderLists++;
        return JSON.stringify({ count: folders.length, data: folders });
      }
      return JSON.stringify({});
    },
    post: async (p: string, body: unknown) => {
      const input = body as { name: string; parentFolderId?: string };
      const folder: Folder = {
        id: `fold-new-${recorded.folderCreates.length + 1}`,
        name: input.name,
        parentFolderId: input.parentFolderId ?? null,
      };
      folders.push(folder);
      recorded.folderCreates.push({ path: p, body: input });
      return JSON.stringify(folder);
    },
    patch: async () => JSON.stringify({}),
    delete: async () => undefined,
  } as unknown as Client;
  const folderService = new FolderService(folderClient);

  return { service, folderService, recorded };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-apply-folders-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLocalYaml(filename: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, filename), [...lines, ""].join("\n"));
}

function writeFoldersYaml(content: string): void {
  fs.writeFileSync(path.join(dir, "folders.yaml"), content);
}

function makeExecutor(
  service: WorkflowService,
  folderService: FolderService | null,
  overrides: Partial<ReturnType<typeof defaultApplyOptions>> = {},
): Executor {
  const opts = defaultApplyOptions();
  opts.directory = dir;
  opts.all = true;
  opts.yamlEnabled = true;
  opts.noLint = true;
  opts.allowDuplicates = true;
  Object.assign(opts, overrides);
  const executor = new Executor(service, opts);
  if (folderService) executor.setFolderService(folderService);
  return executor;
}

describe("apply: folder declarations on create", () => {
  test("a declared path rides the create payload (project known via -p)", async () => {
    writeLocalYaml("wf.yaml", [
      "name: wf",
      "folder: Reporting/Daily",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [
      { id: "rep", name: "Reporting", parentFolderId: null },
      { id: "day", name: "Daily", parentFolderId: "rep" },
    ];
    const { service, folderService, recorded } = buildServices(undefined, folders);

    const result = await makeExecutor(service, folderService, { projectID: "p-remote" }).execute();

    expect(result.createCount).toBe(1);
    expect(recorded.creates[0]?.parentFolderId).toBe("day");
    expect(recorded.moves).toEqual([]); // no separate move needed
    expect(result.operations[0]?.folderApplied).toBe(true);
    expect(result.operations[0]?.folderPath).toBe("Reporting/Daily");
  });

  test("a server too old for parentFolderId on create falls back to create-then-move", async () => {
    writeLocalYaml("wf.yaml", [
      "name: wf",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [{ id: "rep", name: "Reporting", parentFolderId: null }];
    const { service, folderService, recorded } = buildServices(undefined, folders, {
      rejectParentFolderIdOnCreate: true,
    });

    const result = await makeExecutor(service, folderService, { projectID: "p-remote" }).execute();

    expect(result.createCount).toBe(1);
    // The retry must not carry the unsupported property...
    expect(recorded.creates).toHaveLength(1);
    expect("parentFolderId" in (recorded.creates[0] as object)).toBe(false);
    // ...and the move still happens.
    expect(recorded.moves).toEqual([{ id: "new-1", parentFolderId: "rep" }]);
    expect(result.operations[0]?.folderApplied).toBe(true);
  });

  test("no -p: the folder resolves against the project the workflow landed in", async () => {
    writeLocalYaml("wf.yaml", [
      "name: wf",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [{ id: "rep", name: "Reporting", parentFolderId: null }];
    const { service, folderService, recorded } = buildServices(undefined, folders);
    // The create response carries `shared`, which names the landed project.
    const originalCreate = (
      service as unknown as {
        createWorkflow: (input: WorkflowInput, pid?: string) => Promise<Workflow>;
      }
    ).createWorkflow;
    (service as unknown as { createWorkflow: unknown }).createWorkflow = async (
      input: WorkflowInput,
      pid?: string,
    ) => {
      const created = await originalCreate(input, pid);
      return { ...created, shared: [{ role: "workflow:owner", projectId: "p-landed" }] };
    };

    const result = await makeExecutor(service, folderService).execute();

    expect(result.createCount).toBe(1);
    expect(recorded.moves).toEqual([{ id: "new-1", parentFolderId: "rep" }]);
  });

  test("missing folders along the declared path are created on the fly", async () => {
    writeLocalYaml("wf.yaml", [
      "name: wf",
      "folder: New/Deep",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [];
    const { service, folderService, recorded } = buildServices(undefined, folders);

    await makeExecutor(service, folderService, { projectID: "p-remote" }).execute();

    expect(recorded.folderCreates.map((c) => c.body.name)).toEqual(["New", "Deep"]);
    expect(recorded.creates[0]?.parentFolderId).toBe("fold-new-2");
  });
});

describe("apply: folder declarations on update and skip", () => {
  test("an update with an unchanged folder still asserts the move", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [{ id: "rep", name: "Reporting", parentFolderId: null }];
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"), folders);

    const result = await makeExecutor(service, folderService).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.moves).toEqual([{ id: "wf1", parentFolderId: "rep" }]);
    expect(result.operations[0]?.folderApplied).toBe(true);
  });

  test("a fully skipped workflow still gets its folder move", async () => {
    // Content identical to remote → skip — but the folder assignment is
    // write-only upstream, so "no content changes" says nothing about the
    // folder and the declaration is still asserted.
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [{ id: "rep", name: "Reporting", parentFolderId: null }];
    const { service, folderService, recorded } = buildServices(
      remoteWorkflow("wf1", { updatedAt: "2026-05-01T00:00:00.000Z" }),
      folders,
    );

    const result = await makeExecutor(service, folderService).execute();

    expect(result.skipCount).toBe(1);
    expect(recorded.updates).toHaveLength(0);
    expect(recorded.moves).toEqual([{ id: "wf1", parentFolderId: "rep" }]);
  });

  test("folder: null asserts the project root", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf",
      "folder: null",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"));

    const result = await makeExecutor(service, folderService).execute();

    expect(result.skipCount).toBe(1);
    expect(recorded.moves).toEqual([{ id: "wf1", parentFolderId: null }]);
  });

  test("a raw parentFolderId in a JSON file is honoured without folder listings", async () => {
    fs.writeFileSync(
      path.join(dir, "wf__wf1.json"),
      JSON.stringify({
        id: "wf1",
        name: "wf",
        active: false,
        nodes: [],
        connections: {},
        parentFolderId: "fold9",
      }),
    );
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"));

    await makeExecutor(service, folderService).execute();

    expect(recorded.moves).toEqual([{ id: "wf1", parentFolderId: "fold9" }]);
    // Exactly one folder list: resolving the raw ID to a path for the report
    // (cosmetic — its failure would not fail the apply).
    expect(recorded.folderLists).toBe(1);
  });

  test("a malformed folder value degrades to a warning instead of writing garbage", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      // A number is not a folder path — likely a typo for `folder: "1"`.
      "folder: 123",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const folders: Folder[] = [{ id: "rep", name: "Reporting", parentFolderId: null }];
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"), folders);

    const result = await makeExecutor(service, folderService).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.moves).toEqual([]);
    expect(recorded.folderCreates).toEqual([]);
    expect(result.operations[0]?.folderWarning).toMatch(/invalid folder declaration/);
  });

  test("a file without any folder declaration never triggers folder calls", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"));

    await makeExecutor(service, folderService).execute();

    expect(recorded.updates).toHaveLength(1);
    expect(recorded.moves).toEqual([]);
    expect(recorded.folderLists).toBe(0);
  });
});

describe("apply: degradation and strictness", () => {
  test("a folders.yaml sync failure (unlicensed) degrades and the apply continues", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    writeFoldersYaml("projects:\n  - projectId: p-remote\n    folders:\n      - name: X\n");
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"), [], {
      folderLicenseError: true,
    });

    const result = await makeExecutor(service, folderService).execute();

    // The workflow itself is untouched by the folder problem...
    expect(result.skipCount).toBe(1);
    expect(recorded.folderCreates).toEqual([]);
    expect(result.foldersCreated).toEqual([]);
    // ...and no crash escaped the executor.
    expect(result.errorCount).toBe(0);
  });

  test("--strict-folders fails the apply when the folder sync fails", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    writeFoldersYaml("projects:\n  - projectId: p-remote\n    folders:\n      - name: X\n");
    const { service, folderService } = buildServices(remoteWorkflow("wf1"), [], {
      folderLicenseError: true,
    });

    expect(makeExecutor(service, folderService, { strictFolders: true }).execute()).rejects.toThrow(
      /[Ll]icense/,
    );
  });

  test("a folder-less license degrades to a warning and the workflow still applies", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"), [], {
      folderLicenseError: true,
    });

    const result = await makeExecutor(service, folderService).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.updates).toHaveLength(1);
    expect(result.operations[0]?.folderApplied).toBeUndefined();
    expect(result.operations[0]?.folderWarning).toMatch(/[Ll]icense/);
  });

  test("--strict-folders turns the folder failure into an apply error", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, folderService } = buildServices(remoteWorkflow("wf1"), [], {
      folderLicenseError: true,
    });

    const result = await makeExecutor(service, folderService, { strictFolders: true }).execute();

    expect(result.errorCount).toBe(1);
    expect(result.operations[0]?.error?.message).toMatch(/[Ll]icense/);
  });

  test("--no-create-missing-folders refuses an unresolvable path", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      "folder: Missing",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, folderService } = buildServices(remoteWorkflow("wf1"));

    const result = await makeExecutor(service, folderService, {
      createMissingFolders: false,
    }).execute();

    expect(result.updateCount).toBe(1); // content write succeeded
    expect(result.operations[0]?.folderWarning).toMatch(/does not exist/);
  });

  test("--no-folders ignores declarations entirely", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf-renamed",
      "folder: Reporting",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    writeFoldersYaml("projects:\n  - projectId: p1\n    folders:\n      - name: X\n");
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"));

    const result = await makeExecutor(service, folderService, { foldersEnabled: false }).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.moves).toEqual([]);
    expect(recorded.folderLists).toBe(0);
    expect(result.foldersCreated).toEqual([]);
  });
});

describe("apply: dry-run", () => {
  test("folders.yaml sync and folder moves are reported, not performed", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf",
      "folder: Reporting/Daily",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    writeFoldersYaml(
      "projects:\n  - projectId: p-remote\n    folders:\n      - name: Reporting\n        folders:\n          - name: Daily\n",
    );
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"));

    const result = await makeExecutor(service, folderService, { dryRun: true }).execute();

    expect(recorded.updates).toHaveLength(0);
    expect(recorded.moves).toEqual([]);
    expect(recorded.folderCreates).toEqual([]);
    // ...but the plan is visible:
    expect(result.foldersCreated.map((c) => c.path)).toEqual(["Reporting", "Reporting/Daily"]);
    expect(result.operations[0]?.folderApplied).toBe(true);
    expect(result.operations[0]?.folderPath).toBe("Reporting/Daily");
  });
});

describe("apply: folders.yaml sync ordering", () => {
  test("the tree is synced before workflow processing, so the move finds its folder", async () => {
    writeLocalYaml("wf__wf1.yaml", [
      "id: wf1",
      "name: wf",
      "folder: BrandNew",
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    writeFoldersYaml("projects:\n  - projectId: p-remote\n    folders:\n      - name: BrandNew\n");
    const { service, folderService, recorded } = buildServices(remoteWorkflow("wf1"));

    const result = await makeExecutor(service, folderService).execute();

    expect(result.foldersCreated).toEqual([{ projectId: "p-remote", path: "BrandNew" }]);
    // The move used the folder the sync created (not a second one):
    expect(recorded.folderCreates).toHaveLength(1);
    expect(recorded.moves).toEqual([{ id: "wf1", parentFolderId: "fold-new-1" }]);
    expect(result.skipCount).toBe(1);
  });
});
