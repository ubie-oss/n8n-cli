import { isForbiddenError } from "@/api/errors.ts";
import type { FolderService } from "@/api/folder-service.ts";
import { folderPathOf } from "@/api/folder-service.ts";

/**
 * Raised when a folder path cannot be turned into a folder ID.
 *
 * Typed so `apply` can report "this workflow could not be placed" against the
 * one file that asked for it, instead of aborting the whole run: the workflows
 * that named no folder have no reason to fail with it.
 */
export class FolderResolveError extends Error {
  constructor(
    readonly folderPath: string,
    message: string,
  ) {
    super(message);
    this.name = "FolderResolveError";
  }
}

/**
 * Turns declared folder paths into folder IDs for one project, creating the
 * folders that do not exist yet.
 *
 * Scoped to a single project and cached for the lifetime of an apply, because
 * the alternative is one full folder listing per workflow. The cache is also
 * what makes creation safe to do incrementally: two workflows under
 * `Ops/Billing` create `Ops` once, not twice.
 */
export class FolderResolver {
  /** Folder ID by normalised path, seeded from the server on first use. */
  private byPath = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly folderService: FolderService,
    private readonly projectID: string,
    /**
     * Whether a path with no matching folder may be created. When false, an
     * unknown path is an error — the safe choice for a dry run, which must not
     * change anything upstream.
     */
    private readonly createMissing: boolean,
  ) {}

  /**
   * Returns the folder ID for a declared path, or `null` for the project root.
   *
   * An empty path, `/` and `.` all mean the root, which is how a definition
   * says "take this workflow out of whatever folder it is in" — the API's
   * `parentFolderId: null`.
   */
  async resolve(folderPath: string): Promise<string | null> {
    const segments = splitFolderPath(folderPath);
    if (segments.length === 0) return null;

    await this.load();

    let parentID: string | null = null;
    let walked = "";

    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment;

      const known = this.byPath.get(walked);
      if (known) {
        parentID = known;
        continue;
      }

      if (!this.createMissing) {
        throw new FolderResolveError(
          folderPath,
          `folder "${walked}" does not exist in project ${this.projectID}`,
        );
      }

      parentID = await this.create(folderPath, walked, segment, parentID);
    }

    return parentID;
  }

  /** Creates one folder level and records it in the cache. */
  private async create(
    declaredPath: string,
    walked: string,
    name: string,
    parentID: string | null,
  ): Promise<string> {
    try {
      const created = await this.folderService.createFolder(this.projectID, {
        name,
        // Omit the key entirely at the root: the create schema types
        // `parentFolderId` as a plain string and rejects unknown shapes, so an
        // explicit null would be a validation error rather than "at the root".
        ...(parentID ? { parentFolderId: parentID } : {}),
      });
      this.byPath.set(walked, created.id);
      return created.id;
    } catch (err) {
      throw new FolderResolveError(declaredPath, describeFolderFailure(walked, err));
    }
  }

  /** Loads the project's folders once, indexed by their full path. */
  private async load(): Promise<void> {
    if (this.loaded) return;

    let folders: Awaited<ReturnType<FolderService["listAllFolders"]>>;
    try {
      folders = await this.folderService.listAllFolders(this.projectID);
    } catch (err) {
      throw new FolderResolveError("", describeFolderFailure("", err));
    }

    for (const folder of folders) {
      this.byPath.set(folderPathOf(folder), folder.id);
    }
    // Set last: a throw above must leave the resolver unloaded so a later call
    // retries rather than resolving every path against an empty index.
    this.loaded = true;
  }
}

/**
 * Splits a declared folder path into its segments.
 *
 * Empty segments are dropped so `"/Ops//Billing/"` and `"Ops/Billing"` name the
 * same folder — a definition written by hand should not depend on where the
 * author happened to put a slash. Surrounding whitespace goes too, for the same
 * reason.
 */
export function splitFolderPath(folderPath: string): string[] {
  if (!folderPath) return [];
  return folderPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Turns a folder API failure into a message that names the actual problem.
 *
 * A 403 here almost always means the instance has no `feat:folders`
 * entitlement rather than that the caller lacks permission on this one project,
 * and the raw "Forbidden" sends people looking at their API key instead.
 */
function describeFolderFailure(walked: string, err: unknown): string {
  const subject = walked ? `folder "${walked}"` : "folders";
  const detail = err instanceof Error ? err.message : String(err);

  if (isForbiddenError(err)) {
    return (
      `${subject}: the n8n instance rejected the folders API (403). ` +
      "Folders are a licensed feature — check the instance has it enabled, and " +
      "that the API key's scopes cover folder:list and folder:create."
    );
  }

  return `${subject}: ${detail}`;
}
