import { describe, expect, test } from "bun:test";
import type { Client } from "../../src/api/client.ts";
import { APIError, ErrorCode } from "../../src/api/errors.ts";
import {
  buildFolderIndex,
  FolderService,
  findFolderBySegments,
  isFolderUnsupportedError,
  splitFolderPath,
} from "../../src/api/folder-service.ts";
import type { Folder } from "../../src/api/types.ts";

/**
 * The folders API is how n8n-cli reads what it can never read from a
 * workflow's own payload (`parentFolderId` is write-only there), so the
 * service's path algebra — segment splitting, parent chain walking, race
 * handling on create — is what the whole folder feature stands on.
 */

function fakeClient(handlers: {
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  delete?: (path: string) => void;
}): Client {
  return {
    get: async (path: string) => JSON.stringify(handlers.get?.(path) ?? {}),
    post: async (path: string, body: unknown) => JSON.stringify(handlers.post?.(path, body) ?? {}),
    patch: async (path: string, body: unknown) =>
      JSON.stringify(handlers.patch?.(path, body) ?? {}),
    delete: async (path: string) => {
      handlers.delete?.(path);
    },
  } as unknown as Client;
}

function folder(id: string, name: string, parentId?: string | null): Folder {
  return { id, name, parentFolderId: parentId ?? null };
}

describe("splitFolderPath", () => {
  test("splits on slashes and trims whitespace", () => {
    expect(splitFolderPath(" Reporting / Daily ")).toEqual(["Reporting", "Daily"]);
  });

  test("treats root markers as the project root", () => {
    expect(splitFolderPath("")).toEqual([]);
    expect(splitFolderPath("root")).toEqual([]);
    expect(splitFolderPath("ROOT")).toEqual([]);
  });

  test("keeps folder names that merely contain 'root'-like text", () => {
    expect(splitFolderPath("rooted things")).toEqual(["rooted things"]);
  });
});

describe("buildFolderIndex", () => {
  test("resolves nested paths through the parent chain", () => {
    const folders = [
      folder("a", "Reporting"),
      folder("b", "Daily", "a"),
      folder("c", "Nightly", "a"),
    ];
    const { pathById } = buildFolderIndex(folders);
    expect(pathById.get("a")).toBe("Reporting");
    expect(pathById.get("b")).toBe("Reporting/Daily");
    expect(pathById.get("c")).toBe("Reporting/Nightly");
  });

  test("an orphan folder keeps its bare name instead of vanishing", () => {
    // The parent is missing from the list (deleted mid-flight, visibility
    // truncation) — the assignment must still be addressable.
    const { pathById } = buildFolderIndex([folder("b", "Daily", "missing-parent")]);
    expect(pathById.get("b")).toBe("Daily");
  });

  test("a parent cycle terminates the walk (malformed server data)", () => {
    const a = folder("a", "A");
    const b = folder("b", "B", "a");
    // Malformed server data: a's parent points back at b.
    (a as { parentFolderId?: string | null }).parentFolderId = "b";
    const { pathById } = buildFolderIndex([a, b]);
    // The guard stops the walk before looping forever; the exact string does
    // not matter as long as every folder keeps an addressable path.
    expect(pathById.get("a")).toBeTruthy();
    expect(pathById.get("b")).toBeTruthy();
  });

  test("accepts folders that inline the parent object", () => {
    const f = { id: "b", name: "Daily", parentFolder: { id: "a" } } as unknown as Folder;
    const { pathById } = buildFolderIndex([folder("a", "Reporting"), f]);
    expect(pathById.get("b")).toBe("Reporting/Daily");
  });
});

describe("findFolderBySegments", () => {
  test("matches the exact chain and rejects partial matches", () => {
    const folders = [folder("a", "Reporting"), folder("b", "Daily", "a")];
    expect(findFolderBySegments(folders, ["Reporting", "Daily"])?.id).toBe("b");
    expect(findFolderBySegments(folders, ["Daily"])).toBeNull();
    expect(findFolderBySegments(folders, ["Reporting", "Weekly"])).toBeNull();
  });
});

describe("FolderService", () => {
  test("listFolders builds the filter query", async () => {
    const paths: string[] = [];
    const service = new FolderService(
      fakeClient({
        get: (path) => {
          paths.push(path);
          return { count: 0, data: [] };
        },
      }),
    );
    await service.listFolders("p1", { parentFolderId: "root", name: "Daily" });
    const url = new URL(`https://x.example.com${paths[0]}`);
    // The fake client is called with the service-relative path; the real
    // Client prepends `/api/v1`.
    expect(url.pathname).toBe("/projects/p1/folders");
    const filter = JSON.parse(url.searchParams.get("filter") ?? "{}") as Record<string, string>;
    expect(filter).toEqual({ parentFolderId: "root", name: "Daily" });
  });

  test("listAllFolders paginates with skip/take until the count is reached", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) => folder(`f${i}`, `F${i}`));
    const page2 = [folder("f250", "F250")];
    const calls: string[] = [];
    const service = new FolderService(
      fakeClient({
        get: (path) => {
          calls.push(path);
          if (calls.length === 1) return { count: 251, data: page1 };
          return { count: 251, data: page2 };
        },
      }),
    );
    const all = await service.listAllFolders("p1");
    expect(all).toHaveLength(251);
    expect(calls[0]).toContain("skip=0");
    expect(calls[1]).toContain("skip=250");
  });

  test("createFolder posts name and optional parent", async () => {
    const bodies: unknown[] = [];
    const service = new FolderService(
      fakeClient({
        post: (path, body) => {
          bodies.push([path, body]);
          return folder("f1", "Daily", "p0");
        },
      }),
    );
    const created = await service.createFolder("p1", { name: "Daily", parentFolderId: "p0" });
    expect(created.id).toBe("f1");
    expect(bodies[0]).toEqual(["/projects/p1/folders", { name: "Daily", parentFolderId: "p0" }]);
  });

  test("deleteFolder passes the transfer target as a query parameter", async () => {
    const paths: string[] = [];
    const service = new FolderService(
      fakeClient({
        delete: (path) => {
          paths.push(path);
        },
      }),
    );
    await service.deleteFolder("p1", "f1", "f2");
    expect(paths[0]).toBe("/projects/p1/folders/f1?transferToFolderId=f2");
  });

  test("findFolderByPath resolves nested paths and root markers", async () => {
    const folders = [folder("a", "Reporting"), folder("b", "Daily", "a")];
    const service = new FolderService(
      fakeClient({
        get: () => ({ count: folders.length, data: folders }),
      }),
    );
    expect((await service.findFolderByPath("p1", "Reporting/Daily")).folder?.id).toBe("b");
    expect((await service.findFolderByPath("p1", "Reporting")).folder?.id).toBe("a");
    expect((await service.findFolderByPath("p1", "Reporting/Weekly")).folder).toBeNull();
    expect((await service.findFolderByPath("p1", "root")).isRoot).toBe(true);
  });

  test("findOrCreateByPath creates only the missing segments, parent first", async () => {
    const folders = [folder("a", "Reporting")];
    const created: Array<Record<string, unknown>> = [];
    const service = new FolderService(
      fakeClient({
        get: () => ({ count: folders.length, data: [...folders] }),
        post: (_path, body) => {
          created.push(body as Record<string, unknown>);
          const input = body as { name: string; parentFolderId?: string };
          const f = folder(`new-${created.length}`, input.name, input.parentFolderId ?? null);
          folders.push(f);
          return f;
        },
      }),
    );

    // Reporting exists, Daily/2026 does not.
    const result = await service.findOrCreateByPath("p1", "Reporting/Daily/2026");
    expect(created).toEqual([
      { name: "Daily", parentFolderId: "a" },
      { name: "2026", parentFolderId: "new-1" },
    ]);
    expect(result.created).toEqual(["Daily", "2026"]);
    expect(result.folder?.id).toBe("new-2");
  });

  test("findOrCreateByPath survives a 409 from a concurrent creator", async () => {
    // Another process created "Daily" between our list and our create — the
    // same race findOrCreateTag handles for tags.
    let listed = false;
    const service = new FolderService(
      fakeClient({
        get: () => {
          if (listed) return { count: 1, data: [folder("d", "Daily")] };
          listed = true;
          return { count: 0, data: [] };
        },
        post: () => {
          throw new APIError(ErrorCode.CONFLICT_ERROR, "already exists", 409);
        },
      }),
    );
    const result = await service.findOrCreateByPath("p1", "Daily");
    expect(result.created).toEqual([]);
    expect(result.folder?.id).toBe("d");
  });

  test("findOrCreateByPath re-lists once and creates a path it genuinely missed", async () => {
    // The 409 handler re-lists; if the folder really is still absent the
    // original error must surface rather than a null folder.
    const service = new FolderService(
      fakeClient({
        get: () => ({ count: 0, data: [] }),
        post: () => {
          throw new APIError(ErrorCode.CONFLICT_ERROR, "already exists", 409);
        },
      }),
    );
    expect(service.findOrCreateByPath("p1", "Daily")).rejects.toBeInstanceOf(APIError);
  });

  test("an unsupported-server error is recognisable for graceful degradation", () => {
    expect(
      isFolderUnsupportedError(
        new APIError(ErrorCode.VALIDATION_ERROR, "License does not include folders", 403),
      ),
    ).toBe(true);
    expect(isFolderUnsupportedError(new Error("something else"))).toBe(false);
  });
});
