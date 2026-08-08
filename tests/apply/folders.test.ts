import { describe, expect, it } from "bun:test";
import { APIError, ErrorCode } from "../../src/api/errors.ts";
import type { FolderService } from "../../src/api/folder-service.ts";
import type { Folder, FolderInput } from "../../src/api/types.ts";
import { FolderResolveError, FolderResolver, splitFolderPath } from "../../src/apply/folders.ts";

/**
 * A FolderService that keeps its folders in memory, so a resolver can be driven
 * through create-and-reuse without a server.
 */
class FakeFolderService {
  readonly created: FolderInput[] = [];
  listCalls = 0;
  listError?: Error;
  createError?: Error;

  constructor(private folders: Folder[] = []) {}

  async listAllFolders(): Promise<Folder[]> {
    this.listCalls++;
    if (this.listError) throw this.listError;
    return this.folders;
  }

  async createFolder(_projectID: string, input: FolderInput): Promise<Folder> {
    if (this.createError) throw this.createError;
    this.created.push(input);
    const folder: Folder = {
      id: `id-${this.created.length}`,
      name: input.name,
      parentFolderId: input.parentFolderId ?? null,
    };
    this.folders.push(folder);
    return folder;
  }

  asService(): FolderService {
    return this as unknown as FolderService;
  }
}

describe("splitFolderPath", () => {
  it("splits on slashes", () => {
    expect(splitFolderPath("Ops/Billing")).toEqual(["Ops", "Billing"]);
  });

  it("ignores empty, whitespace and dot segments", () => {
    expect(splitFolderPath("/Ops// Billing /")).toEqual(["Ops", "Billing"]);
    expect(splitFolderPath("./Ops")).toEqual(["Ops"]);
  });

  it("treats the root spellings as no folder at all", () => {
    expect(splitFolderPath("")).toEqual([]);
    expect(splitFolderPath("/")).toEqual([]);
    expect(splitFolderPath(".")).toEqual([]);
  });
});

describe("FolderResolver", () => {
  it("resolves an existing nested path without creating anything", async () => {
    const service = new FakeFolderService([
      { id: "f1", name: "Ops" },
      { id: "f2", name: "Billing", parentFolder: { id: "f1", name: "Ops" } },
    ]);
    const resolver = new FolderResolver(service.asService(), "p", true);

    expect(await resolver.resolve("Ops/Billing")).toBe("f2");
    expect(service.created).toEqual([]);
  });

  it("returns null for the project root", async () => {
    const service = new FakeFolderService();
    const resolver = new FolderResolver(service.asService(), "p", true);

    expect(await resolver.resolve("")).toBeNull();
    expect(await resolver.resolve("/")).toBeNull();
    // The root needs no lookup at all, so no listing should have happened.
    expect(service.listCalls).toBe(0);
  });

  it("creates the missing levels of a path, innermost last", async () => {
    const service = new FakeFolderService();
    const resolver = new FolderResolver(service.asService(), "p", true);

    const id = await resolver.resolve("Ops/Billing");

    expect(service.created).toEqual([{ name: "Ops" }, { name: "Billing", parentFolderId: "id-1" }]);
    expect(id).toBe("id-2");
  });

  it("creates a shared ancestor only once across resolutions", async () => {
    const service = new FakeFolderService();
    const resolver = new FolderResolver(service.asService(), "p", true);

    await resolver.resolve("Ops/Billing");
    await resolver.resolve("Ops/Payroll");

    expect(service.created.map((c) => c.name)).toEqual(["Ops", "Billing", "Payroll"]);
    expect(service.listCalls).toBe(1);
  });

  it("refuses to create when creation is off", async () => {
    const service = new FakeFolderService([{ id: "f1", name: "Ops" }]);
    const resolver = new FolderResolver(service.asService(), "p", false);

    await expect(resolver.resolve("Ops/Billing")).rejects.toThrow(FolderResolveError);
    expect(service.created).toEqual([]);
  });

  it("still resolves an existing path when creation is off", async () => {
    const service = new FakeFolderService([{ id: "f1", name: "Ops" }]);
    const resolver = new FolderResolver(service.asService(), "p", false);

    expect(await resolver.resolve("Ops")).toBe("f1");
  });

  it("explains a 403 as the folders feature not being available", async () => {
    const service = new FakeFolderService();
    service.listError = new APIError(ErrorCode.UNKNOWN_ERROR, "Forbidden", 403);
    const resolver = new FolderResolver(service.asService(), "p", true);

    await expect(resolver.resolve("Ops")).rejects.toThrow(/licensed feature/);
  });

  it("retries the listing after a failure instead of resolving against nothing", async () => {
    const service = new FakeFolderService([{ id: "f1", name: "Ops" }]);
    service.listError = new Error("transient");
    const resolver = new FolderResolver(service.asService(), "p", false);

    await expect(resolver.resolve("Ops")).rejects.toThrow(/transient/);

    // A resolver that had marked itself loaded would now report "Ops" missing,
    // and with creation on would silently create a duplicate of it.
    service.listError = undefined;
    expect(await resolver.resolve("Ops")).toBe("f1");
  });

  it("names the level that failed to be created", async () => {
    const service = new FakeFolderService();
    service.createError = new Error("boom");
    const resolver = new FolderResolver(service.asService(), "p", true);

    await expect(resolver.resolve("Ops/Billing")).rejects.toThrow(/folder "Ops": boom/);
  });
});
