import type { Client } from "./client.ts";
import type { Folder, FolderInput, FolderUpdateInput, ListFoldersResponse } from "./types.ts";

/**
 * Project ID accepted by the folder endpoints in place of a real ID, resolving
 * to the caller's own personal project. Spelled out here because it is the only
 * sensible default for a CLI run by a person rather than by a project-scoped
 * service account.
 */
export const PERSONAL_PROJECT = "personal";

/** ListFoldersOptions represents options for listing folders in a project. */
export interface ListFoldersOptions {
  /** Restrict to direct children of this folder. */
  parentFolderId?: string;
  /** Substring match on the folder name, applied server-side. */
  name?: string;
  /** Number of folders to skip; the offset half of the API's skip/take paging. */
  skip?: number;
  /** Page size. The API defaults to 10, which is never what a sync wants. */
  take?: number;
}

/**
 * Fields requested from the list endpoint.
 *
 * `parentFolder` is the load-bearing one: without it the response carries no
 * link to the enclosing folder, and building a path like `Ops/Billing` would
 * take one request per level. The API returns only what `select` names, so this
 * is not merely an optimisation — omitting it changes what comes back.
 */
const LIST_SELECT_FIELDS = ["id", "name", "parentFolder", "createdAt", "updatedAt"] as const;

/** Page size used when walking every folder in a project. */
const LIST_ALL_PAGE_SIZE = 100;

/**
 * Upper bound on pages walked by {@link FolderService.listAllFolders}.
 *
 * The loop already stops when a page comes back short, so this only matters if
 * the server keeps reporting full pages — a paginator that never terminates
 * would otherwise pin the process against an instance the user cannot fix.
 */
const LIST_ALL_MAX_PAGES = 100;

/** FolderService handles folder API operations within a project. */
export class FolderService {
  constructor(private readonly client: Client) {}

  /** ListFolders lists one page of folders in a project. */
  async listFolders(projectID: string, opts?: ListFoldersOptions): Promise<ListFoldersResponse> {
    const params = new URLSearchParams();

    // `filter` is a JSON blob rather than repeated query keys — that is how the
    // endpoint is specified, so it is built here instead of by the caller.
    const filter: Record<string, unknown> = {};
    if (opts?.parentFolderId !== undefined) filter.parentFolderId = opts.parentFolderId;
    if (opts?.name !== undefined) filter.name = opts.name;
    if (Object.keys(filter).length > 0) params.set("filter", JSON.stringify(filter));

    params.set("select", JSON.stringify(LIST_SELECT_FIELDS));
    if (opts?.skip !== undefined) params.set("skip", String(opts.skip));
    if (opts?.take !== undefined) params.set("take", String(opts.take));

    const path = `${this.basePath(projectID)}?${params.toString()}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as ListFoldersResponse;
  }

  /**
   * ListAllFolders walks every folder in a project.
   *
   * Paging is skip/take here, not the cursor the rest of the API uses, so the
   * walk ends on a short page rather than on a missing cursor. `count` is
   * consulted as well, because a server that reports a total lets the walk stop
   * one request earlier than probing for an empty page would.
   */
  async listAllFolders(projectID: string, opts?: ListFoldersOptions): Promise<Folder[]> {
    const all: Folder[] = [];
    const take = opts?.take ?? LIST_ALL_PAGE_SIZE;

    for (let page = 0; page < LIST_ALL_MAX_PAGES; page++) {
      const resp = await this.listFolders(projectID, { ...opts, skip: all.length, take });
      all.push(...resp.data);

      if (resp.data.length < take) break;
      if (typeof resp.count === "number" && all.length >= resp.count) break;
    }

    return all;
  }

  /** GetFolder retrieves a single folder by ID. */
  async getFolder(projectID: string, folderID: string): Promise<Folder> {
    const path = `${this.basePath(projectID)}/${encodeURIComponent(folderID)}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as Folder;
  }

  /** CreateFolder creates a folder, optionally nested under another one. */
  async createFolder(projectID: string, input: FolderInput): Promise<Folder> {
    const data = await this.client.post(this.basePath(projectID), input);
    return JSON.parse(data) as Folder;
  }

  /** UpdateFolder renames a folder or moves it under a different parent. */
  async updateFolder(
    projectID: string,
    folderID: string,
    input: FolderUpdateInput,
  ): Promise<Folder> {
    const path = `${this.basePath(projectID)}/${encodeURIComponent(folderID)}`;
    const data = await this.client.patch(path, input);
    return JSON.parse(data) as Folder;
  }

  /**
   * DeleteFolder deletes a folder.
   *
   * `transferToFolderId` moves the folder's workflows and sub-folders somewhere
   * else first. Without it the server decides what happens to the contents, so
   * a caller deleting a non-empty folder should always pass one.
   */
  async deleteFolder(
    projectID: string,
    folderID: string,
    transferToFolderID?: string,
  ): Promise<void> {
    const params = new URLSearchParams();
    if (transferToFolderID) params.set("transferToFolderId", transferToFolderID);
    const query = params.toString();
    const path = `${this.basePath(projectID)}/${encodeURIComponent(folderID)}${
      query ? `?${query}` : ""
    }`;
    await this.client.delete(path);
  }

  private basePath(projectID: string): string {
    return `/projects/${encodeURIComponent(projectID)}/folders`;
  }
}

/**
 * Renders a folder's `/`-joined path from the ancestor chain the server nested
 * inside it, outermost first.
 *
 * Falls back to the folder's own name when no chain was requested, so a caller
 * that skipped `select=parentFolder` gets something usable rather than a lie —
 * but note it would be indistinguishable from a genuine root-level folder.
 */
export function folderPathOf(folder: Folder): string {
  const segments: string[] = [folder.name];

  // Bounded by the same limit the walk uses: a cycle in the chain (which the
  // server should never produce, but which would hang this loop) is worth
  // truncating rather than trusting.
  let parent = folder.parentFolder;
  for (let depth = 0; parent && depth < LIST_ALL_MAX_PAGES; depth++) {
    segments.unshift(parent.name);
    parent = parent.parentFolder;
  }

  return segments.join("/");
}
