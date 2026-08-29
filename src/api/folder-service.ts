import type { Client } from "./client.ts";
import { isConflictError } from "./errors.ts";
import type { Folder, FolderInput, FolderUpdateInput, ListFoldersResponse } from "./types.ts";

/** Options for listing folders within a project. */
export interface ListFoldersOptions {
  /** Filter by direct parent. Use the literal string "root" for the project root. */
  parentFolderId?: string;
  name?: string;
  skip?: number;
  take?: number;
}

/** Page size for listAllFolders pagination. Matches the tags paginator. */
const FOLDER_PAGE_SIZE = 250;

/**
 * FolderService handles n8n's folder API.
 *
 * Folders live under a project (`/projects/{projectId}/folders`) and are an
 * enterprise feature (`feat:folders` license + `folder:*` API-key scopes). A
 * community-edition server answers these routes with a license error, which
 * callers are expected to degrade from gracefully — folder support is an
 * enhancement, never a hard dependency of workflow management.
 *
 * The workflow's own folder assignment is a separate, write-only field
 * (`parentFolderId` on the workflow payload); the folders API is how a folder
 * assignment gets *read back* — by listing the project's folders and mapping
 * workflow IDs through `FolderService.getWorkflowFolderMap`-style helpers.
 */
export class FolderService {
  constructor(private readonly client: Client) {}

  /** ListFolders lists folders in a project (one page). */
  async listFolders(projectId: string, opts?: ListFoldersOptions): Promise<ListFoldersResponse> {
    const params = new URLSearchParams();
    if (opts?.parentFolderId !== undefined) {
      const filter: Record<string, string> = { parentFolderId: opts.parentFolderId };
      params.set("filter", JSON.stringify(filter));
    }
    if (opts?.name) {
      // The name filter rides in the same JSON filter object.
      const existing = params.get("filter");
      const parsed = existing ? (JSON.parse(existing) as Record<string, string>) : {};
      parsed.name = opts.name;
      params.set("filter", JSON.stringify(parsed));
    }
    if (opts?.skip !== undefined) params.set("skip", String(opts.skip));
    if (opts?.take !== undefined) params.set("take", String(opts.take));

    const query = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/folders${query ? `?${query}` : ""}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as ListFoldersResponse;
  }

  /** ListAllFolders lists every folder in a project with automatic pagination. */
  async listAllFolders(projectId: string): Promise<Folder[]> {
    const all: Folder[] = [];
    let skip = 0;

    for (;;) {
      const resp = await this.listFolders(projectId, { skip, take: FOLDER_PAGE_SIZE });
      all.push(...resp.data);
      skip += resp.data.length;
      // No cursor in the folders API — stop when a short page (or the count)
      // says we have everything.
      if (resp.data.length < FOLDER_PAGE_SIZE || skip >= resp.count) break;
    }

    return all;
  }

  /** GetFolder retrieves a single folder by ID. */
  async getFolder(projectId: string, folderId: string): Promise<Folder> {
    const path = `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as Folder;
  }

  /** CreateFolder creates a folder, optionally inside a parent folder. */
  async createFolder(projectId: string, input: FolderInput): Promise<Folder> {
    const path = `/projects/${encodeURIComponent(projectId)}/folders`;
    const data = await this.client.post(path, input);
    return JSON.parse(data) as Folder;
  }

  /** UpdateFolder renames and/or moves a folder (PATCH semantics). */
  async updateFolder(
    projectId: string,
    folderId: string,
    input: FolderUpdateInput,
  ): Promise<Folder> {
    const path = `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`;
    const data = await this.client.patch(path, input);
    return JSON.parse(data) as Folder;
  }

  /**
   * DeleteFolder deletes a folder. `transferToFolderId` moves the folder's
   * workflows and subfolders somewhere else first; omit it (or pass null) to
   * move them to the project root.
   */
  async deleteFolder(
    projectId: string,
    folderId: string,
    transferToFolderId?: string,
  ): Promise<void> {
    let path = `/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`;
    if (transferToFolderId) {
      path += `?transferToFolderId=${encodeURIComponent(transferToFolderId)}`;
    }
    await this.client.delete(path);
  }

  /**
   * FindFolderByPath resolves a `/`-separated folder path (e.g.
   * `"Reporting/Daily"`) to a folder in the project. Returns null when any
   * segment is missing. An empty path or the literal root markers resolve to
   * null with `isRoot` set — the project root is not a folder object.
   */
  async findFolderByPath(
    projectId: string,
    folderPath: string,
  ): Promise<{ folder: Folder | null; isRoot: boolean }> {
    const segments = splitFolderPath(folderPath);
    if (segments.length === 0) return { folder: null, isRoot: true };

    const folders = await this.listAllFolders(projectId);
    const folder = findFolderBySegments(folders, segments);
    return { folder, isRoot: false };
  }

  /**
   * FindOrCreateByPath resolves a folder path, creating any missing segment.
   *
   * Folder creation does not accept a caller-chosen ID, so paths — not IDs —
   * are the stable handle local files use. Creation is per segment,
   * parent-before-child, and a 409 from a concurrent creator is resolved by
   * re-listing and matching by name (same strategy as findOrCreateTag).
   */
  async findOrCreateByPath(
    projectId: string,
    folderPath: string,
  ): Promise<{ folder: Folder | null; created: string[]; isRoot: boolean }> {
    const segments = splitFolderPath(folderPath);
    const created: string[] = [];
    if (segments.length === 0) return { folder: null, created, isRoot: true };

    let parentFolderId: string | undefined;
    let current: Folder | null = null;

    for (const segment of segments) {
      const existing = await this.findChildByName(projectId, parentFolderId, segment);
      if (existing) {
        current = existing;
        parentFolderId = existing.id;
        continue;
      }
      const createdFolder = await this.createWithRaceHandling(projectId, parentFolderId, segment);
      if (createdFolder.createdNow) created.push(segment);
      current = createdFolder.folder;
      parentFolderId = current.id;
    }

    return { folder: current, created, isRoot: false };
  }

  /**
   * Finds a direct child folder by name under `parentFolderId` (undefined =
   * project root). Walks the full folder list and filters locally, which is
   * one API call regardless of nesting depth and tolerant of servers that
   * ignore the filter parameter.
   */
  private async findChildByName(
    projectId: string,
    parentFolderId: string | undefined,
    name: string,
  ): Promise<Folder | null> {
    const folders = await this.listAllFolders(projectId);
    const parent = (f: Folder): string | null => f.parentFolderId ?? f.parentFolder?.id ?? null;
    const match = folders.find(
      (f) => f.name === name && (parent(f) ?? null) === (parentFolderId ?? null),
    );
    return match ?? null;
  }

  private async createWithRaceHandling(
    projectId: string,
    parentFolderId: string | undefined,
    name: string,
  ): Promise<{ folder: Folder; createdNow: boolean }> {
    try {
      const folder = await this.createFolder(projectId, {
        name,
        ...(parentFolderId !== undefined ? { parentFolderId } : {}),
      });
      return { folder, createdNow: true };
    } catch (err) {
      if (isConflictError(err)) {
        // Another writer created it between our list and our create.
        const existing = await this.findChildByName(projectId, parentFolderId, name);
        if (existing) return { folder: existing, createdNow: false };
      }
      throw err;
    }
  }
}

/**
 * Splits a folder path declaration into segments. The literal `"root"`
 * (case-insensitive) and an empty result mean the project root; `/` and `\`
 * are separators; surrounding slashes and whitespace are trimmed. A segment
 * may not be empty (`"a//b"` is an error shape callers reject before calling).
 */
export function splitFolderPath(folderPath: string): string[] {
  const trimmed = folderPath.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "root") return [];
  return trimmed
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Finds a folder matching the exact segment path within a folder list. */
export function findFolderBySegments(folders: Folder[], segments: string[]): Folder | null {
  let parentId: string | null = null;
  let current: Folder | null = null;

  for (const segment of segments) {
    const candidate = folders.find(
      (f) => f.name === segment && (f.parentFolderId ?? f.parentFolder?.id ?? null) === parentId,
    );
    if (!candidate) return null;
    current = candidate;
    parentId = candidate.id;
  }

  return current;
}

/** Returns the parent folder ID of a folder, normalised to null at the root. */
export function folderParentId(folder: Folder): string | null {
  return folder.parentFolderId ?? folder.parentFolder?.id ?? null;
}

/**
 * Builds lookup maps over a project's folders:
 *  - `byId`: folder ID → folder
 *  - `pathById`: folder ID → `/`-separated path from the project root
 *
 * Folders whose parent is missing from the list (deleted mid-flight, or
 * outside the caller's visibility) keep their bare name as the path, so a
 * workflow's assignment is never silently dropped for lack of one ancestor.
 */
export function buildFolderIndex(folders: Folder[]): {
  byId: Map<string, Folder>;
  pathById: Map<string, string>;
} {
  const byId = new Map<string, Folder>();
  for (const folder of folders) byId.set(folder.id, folder);

  const pathById = new Map<string, string>();
  for (const folder of folders) {
    const segments: string[] = [folder.name];
    let cursor = folder;
    const guard = new Set<string>([folder.id]);
    for (;;) {
      const parentId = folderParentId(cursor);
      if (!parentId) break;
      const parent = byId.get(parentId);
      if (!parent) break; // Orphan: keep what we have.
      if (guard.has(parent.id)) break; // Cycle guard — malformed server data.
      guard.add(parent.id);
      segments.unshift(parent.name);
      cursor = parent;
    }
    pathById.set(folder.id, segments.join("/"));
  }

  return { byId, pathById };
}

/** True when the error means "this server cannot manage folders at all". */
export function isFolderUnsupportedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("license") ||
    message.includes("folder:") ||
    message.includes("feat:folders") ||
    message.includes("not licensed") ||
    message.includes("upgrade")
  );
}
