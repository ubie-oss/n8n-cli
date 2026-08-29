import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "../../src/api/client.ts";
import { FolderService } from "../../src/api/folder-service.ts";
import type { Folder, Workflow } from "../../src/api/types.ts";
import {
  FolderAssignmentResolver,
  type FolderSyncReport,
  loadFoldersConfig,
  parseFolderDeclaration,
  syncFolderTree,
  validateFoldersConfig,
} from "../../src/apply/folders.ts";

/**
 * Folder-as-code primitives: the declaration grammar workflow files use, the
 * folders.yaml schema, the tree sync, and the path→ID resolver that bridges
 * them. The REST API makes folder assignments write-only and folder IDs
 * server-assigned, so paths are the only stable handle a local file has.
 */

function fakeFolderService(state: {
  folders: Folder[];
  created?: Array<{ projectId: string; body: Record<string, unknown> }>;
}): FolderService {
  const client = {
    get: async (p: string) => {
      if (p.startsWith("/projects/")) {
        return JSON.stringify({ count: state.folders.length, data: state.folders });
      }
      return JSON.stringify({});
    },
    post: async (p: string, body: unknown) => {
      const input = body as { name: string; parentFolderId?: string };
      const folder: Folder = {
        id: `new-${state.created!.length + 1}`,
        name: input.name,
        parentFolderId: input.parentFolderId ?? null,
      };
      state.folders.push(folder);
      state.created?.push({ projectId: p, body: input });
      return JSON.stringify(folder);
    },
    patch: async () => JSON.stringify({}),
    delete: async () => undefined,
  } as unknown as Client;
  return new FolderService(client);
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-folders-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseFolderDeclaration", () => {
  const workflow = (fields: Partial<Workflow>): Workflow =>
    ({ id: "wf1", name: "wf", active: false, nodes: [], connections: {}, ...fields }) as Workflow;

  test("an absent key means the folder is not managed", () => {
    expect(parseFolderDeclaration(workflow({}))).toEqual({ declared: false, path: null });
  });

  test("a path string is a folder declaration", () => {
    const decl = parseFolderDeclaration(workflow({ folder: "Reporting/Daily" }));
    expect(decl.declared).toBe(true);
    expect(decl.path).toBe("Reporting/Daily");
  });

  test("null and the 'root' marker mean the project root", () => {
    expect(parseFolderDeclaration(workflow({ folder: null }))).toEqual({
      declared: true,
      path: null,
    });
    expect(parseFolderDeclaration(workflow({ folder: "root" }))).toEqual({
      declared: true,
      path: null,
    });
    expect(parseFolderDeclaration(workflow({ folder: "ROOT" }))).toEqual({
      declared: true,
      path: null,
    });
  });

  test("a raw parentFolderId (JSON imports) is a declaration by ID", () => {
    expect(parseFolderDeclaration(workflow({ parentFolderId: "fold1" }))).toEqual({
      declared: true,
      path: null,
      parentFolderId: "fold1",
    });
    expect(parseFolderDeclaration(workflow({ parentFolderId: null }))).toEqual({
      declared: true,
      path: null,
      parentFolderId: null,
    });
  });

  test("an empty parentFolderId string reads as the project root", () => {
    expect(parseFolderDeclaration(workflow({ parentFolderId: "" }))).toEqual({
      declared: true,
      path: null,
      parentFolderId: null,
    });
  });

  test("the folder key wins over a raw parentFolderId", () => {
    // Both keys can appear in a JSON file written by an MCP-backed import;
    // the human-facing declaration is authoritative.
    const decl = parseFolderDeclaration(workflow({ folder: "A/B", parentFolderId: "fold9" }));
    expect(decl.path).toBe("A/B");
    expect(decl.parentFolderId).toBeUndefined();
  });
});

describe("folders.yaml loading", () => {
  test("loads and validates a tree from folders.yaml", () => {
    fs.writeFileSync(
      path.join(dir, "folders.yaml"),
      [
        "projects:",
        "  - projectId: p1",
        "    folders:",
        "      - name: Reporting",
        "        folders:",
        "          - name: Daily",
        "      - name: TeamA",
      ].join("\n"),
    );
    const loaded = loadFoldersConfig(dir);
    expect(loaded?.file).toBe(path.join(dir, "folders.yaml"));
    expect(loaded?.config.projects).toHaveLength(1);
    expect(loaded?.config.projects[0]?.folders?.[0]?.folders?.[0]?.name).toBe("Daily");
  });

  test("returns null when no folder file exists", () => {
    expect(loadFoldersConfig(dir)).toBeNull();
  });

  test("rejects duplicate sibling names, nested names with slashes, and the root marker", () => {
    expect(() =>
      validateFoldersConfig({ projects: [{ folders: [{ name: "A" }, { name: "A" }] }] }),
    ).toThrow(/twice/);
    expect(() => validateFoldersConfig({ projects: [{ folders: [{ name: "A/B" }] }] })).toThrow(
      /without "\/"/,
    );
    expect(() => validateFoldersConfig({ projects: [{ folders: [{ name: "root" }] }] })).toThrow(
      /reserved/,
    );
    expect(() => validateFoldersConfig({})).toThrow(/projects/);
    expect(() => validateFoldersConfig({ projects: {} })).toThrow(/array/);
  });
});

describe("syncFolderTree", () => {
  test("creates missing folders parent-first and reports existing ones", async () => {
    const state = {
      folders: [{ id: "rep", name: "Reporting", parentFolderId: null }] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const service = fakeFolderService(state);

    const report = await syncFolderTree(
      service,
      {
        projects: [
          {
            projectId: "p1",
            folders: [{ name: "Reporting", folders: [{ name: "Daily" }] }, { name: "TeamA" }],
          },
        ],
      },
      { defaultProjectId: "p1" },
    );

    expect(report.existing).toEqual([{ projectId: "p1", path: "Reporting" }]);
    expect(report.created.map((c) => c.path)).toEqual(["Reporting/Daily", "TeamA"]);
    // Daily must be created *under* Reporting, which itself was never created.
    expect(state.created[0]?.body).toEqual({ name: "Daily", parentFolderId: "rep" });
    expect(state.created[1]?.body).toEqual({ name: "TeamA" });
  });

  test("dry-run reports would-be creations without calling the API", async () => {
    const state = {
      folders: [] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const service = fakeFolderService(state);

    const report = await syncFolderTree(
      service,
      { projects: [{ projectId: "p1", folders: [{ name: "A", folders: [{ name: "B" }] }] }] },
      { dryRun: true },
    );

    expect(state.created).toEqual([]);
    expect(report.created).toEqual([
      { projectId: "p1", path: "A" },
      { projectId: "p1", path: "A/B" },
    ]);
  });

  test("sections without a projectId use the default; multiple unknown sections are an error", async () => {
    const state = {
      folders: [] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const service = fakeFolderService(state);

    const report: FolderSyncReport = await syncFolderTree(
      service,
      { projects: [{ folders: [{ name: "Shared" }] }] },
      { defaultProjectId: "p-default" },
    );
    expect(report.created).toEqual([{ projectId: "p-default", path: "Shared" }]);

    expect(
      syncFolderTree(
        service,
        { projects: [{ folders: [{ name: "A" }] }, { folders: [{ name: "B" }] }] },
        { defaultProjectId: "p-default" },
      ),
    ).rejects.toThrow(/projectId/);
  });

  test("a section with no project anywhere is skipped with a reason, not a crash", async () => {
    const state = {
      folders: [] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const service = fakeFolderService(state);

    const report = await syncFolderTree(
      service,
      { projects: [{ folders: [{ name: "Shared" }] }] },
      {},
    );
    expect(report.created).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.reason).toContain("default project");
  });
});

describe("FolderAssignmentResolver", () => {
  test("resolves an existing path without any create call", async () => {
    const state = {
      folders: [
        { id: "a", name: "Reporting", parentFolderId: null },
        { id: "b", name: "Daily", parentFolderId: "a" },
      ] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const resolver = new FolderAssignmentResolver(fakeFolderService(state));

    const resolved = await resolver.resolve(
      "p1",
      parseFolderDeclaration({ folder: "Reporting/Daily" } as Workflow),
    );
    expect(resolved?.parentFolderId).toBe("b");
    expect(resolved?.created).toEqual([]);
    expect(await resolver.pathFor("p1", "b")).toBe("Reporting/Daily");
  });

  test("creates missing paths when allowed, and reports them", async () => {
    const state = {
      folders: [] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const resolver = new FolderAssignmentResolver(fakeFolderService(state));

    const resolved = await resolver.resolve(
      "p1",
      parseFolderDeclaration({ folder: "A/B" } as Workflow),
    );
    expect(resolved?.created).toEqual(["A", "B"]);
    expect(resolved?.parentFolderId).toBe("new-2");
    expect(state.created[0]?.body).toEqual({ name: "A" });
    expect(state.created[1]?.body).toEqual({ name: "B", parentFolderId: "new-1" });
  });

  test("dry-run plans creations synthetically without touching the API", async () => {
    const state = {
      folders: [] as Folder[],
      created: [] as Array<{ projectId: string; body: Record<string, unknown> }>,
    };
    const resolver = new FolderAssignmentResolver(fakeFolderService(state), { dryRun: true });

    const resolved = await resolver.resolve(
      "p1",
      parseFolderDeclaration({ folder: "A/B" } as Workflow),
    );
    expect(state.created).toEqual([]);
    expect(resolved?.created).toEqual(["A", "B"]);
  });

  test("a root declaration resolves to null without any API call", async () => {
    const service = fakeFolderService({ folders: [], created: [] });
    const resolver = new FolderAssignmentResolver(service, { createMissing: false });
    const resolved = await resolver.resolve(
      "p1",
      parseFolderDeclaration({ folder: "root" } as Workflow),
    );
    expect(resolved?.parentFolderId).toBeNull();
  });

  test("an unresolvable path errors when creation is disabled", async () => {
    const resolver = new FolderAssignmentResolver(fakeFolderService({ folders: [] }), {
      createMissing: false,
    });
    expect(
      resolver.resolve("p1", parseFolderDeclaration({ folder: "Missing" } as Workflow)),
    ).rejects.toThrow(/does not exist/);
  });

  test("a raw parentFolderId is passed through untouched (no list call)", async () => {
    let listed = 0;
    const service = fakeFolderService({ folders: [], created: [] });
    const originalList = service.listAllFolders.bind(service);
    service.listAllFolders = async (projectId: string) => {
      listed++;
      return originalList(projectId);
    };
    const resolver = new FolderAssignmentResolver(service);

    const resolved = await resolver.resolve(
      "p1",
      parseFolderDeclaration({ parentFolderId: "fold9" } as Workflow),
    );
    expect(resolved?.parentFolderId).toBe("fold9");
    expect(listed).toBe(0);
  });

  test("resolutions are cached per project (one list per project, not per workflow)", async () => {
    let lists = 0;
    const state = {
      folders: [{ id: "a", name: "Reporting", parentFolderId: null }] as Folder[],
    };
    const service = fakeFolderService(state);
    const originalList = service.listAllFolders.bind(service);
    service.listAllFolders = async (projectId: string) => {
      lists++;
      return originalList(projectId);
    };
    const resolver = new FolderAssignmentResolver(service);

    await resolver.resolve("p1", parseFolderDeclaration({ folder: "Reporting" } as Workflow));
    await resolver.resolve("p1", parseFolderDeclaration({ folder: "Reporting" } as Workflow));
    await resolver.resolve("p2", parseFolderDeclaration({ folder: "Reporting" } as Workflow));

    expect(lists).toBe(2); // once per project
  });
});
