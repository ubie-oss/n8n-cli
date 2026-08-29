import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { FolderService } from "@/api/folder-service.ts";
import { buildFolderIndex, folderParentId, splitFolderPath } from "@/api/folder-service.ts";
import type { Folder, Workflow } from "@/api/types.ts";

/**
 * Folder-as-code support for `apply`.
 *
 * A workflow file can declare the folder it belongs to (YAML `folder:` path,
 * JSON `parentFolderId`), and a definitions directory can carry a
 * `folders.yaml` describing whole folder trees. n8n's REST API makes the
 * workflow→folder assignment write-only (`parentFolderId` never appears in a
 * GET response) and does not let a caller choose folder IDs at creation, so
 * local files address folders by *path* and apply resolves paths to IDs
 * through the folders API, creating missing folders as needed.
 */

/** Marker strings that mean "the project root" in a folder declaration. */
const ROOT_MARKERS = new Set(["", "root"]);

/**
 * The parsed folder declaration of a workflow file.
 *
 * `declared === false` means the file does not manage the folder at all —
 * apply must leave the upstream assignment untouched. This mirrors the
 * write-only API semantics: omitting `parentFolderId` on an update is
 * documented n8n behaviour for "leave the current folder alone".
 */
export interface FolderDeclaration {
  declared: boolean;
  /**
   * Folder path ("Reporting/Daily") or null for the project root. Only
   * meaningful when `declared` is true and `parentFolderId` is unset.
   */
  path: string | null;
  /**
   * Raw folder ID when the file carries `parentFolderId` directly (JSON files
   * written by an MCP-backed import). Takes precedence over `path`.
   */
  parentFolderId?: string | null;
}

/** Extracts the folder declaration from a workflow definition. */
export function parseFolderDeclaration(workflow: Workflow): FolderDeclaration {
  // The YAML-level `folder` key wins: it is the human-authored form, and an
  // import that wrote both keys derives them from the same source anyway.
  if (workflow.folder !== undefined) {
    const value = workflow.folder;
    if (value === null) {
      return { declared: true, path: null };
    }
    if (typeof value === "string") {
      if (ROOT_MARKERS.has(value.trim().toLowerCase())) {
        return { declared: true, path: null };
      }
      if (splitFolderPath(value).length > 0) {
        return { declared: true, path: value };
      }
    }
    // A present-but-unusable value (a number, an empty string, an object) is
    // a mistake in the file, and silently ignoring it would hide the typo.
    throw new Error(
      `invalid folder declaration ${JSON.stringify(value)}: expected a folder path like "Reporting/Daily", "root", or null`,
    );
  }

  if (workflow.parentFolderId !== undefined) {
    const id = workflow.parentFolderId;
    if (id === null || id === "") {
      return { declared: true, path: null, parentFolderId: null };
    }
    if (typeof id === "string") {
      return { declared: true, path: null, parentFolderId: id };
    }
  }

  return { declared: false, path: null };
}

/**
 * How a folder declaration resolves for one workflow.
 * `parentFolderId === null` means the project root.
 */
export interface ResolvedFolderAssignment {
  parentFolderId: string | null;
  /** Folder segments this resolution had to create (empty when it found everything). */
  created: string[];
}

/** Error thrown when a folder path cannot be resolved and creation is off. */
export class FolderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FolderResolutionError";
  }
}

/**
 * Resolves folder declarations to folder IDs, caching one folder index per
 * project so a directory of workflows costs one list call per project.
 */
export class FolderAssignmentResolver {
  private indexCache = new Map<string, Map<string, Folder>>();
  private pathCache = new Map<string, Map<string, string>>();

  constructor(
    private readonly folderService: FolderService,
    private readonly opts: { dryRun?: boolean; createMissing?: boolean } = {},
  ) {}

  /**
   * Resolves a declaration against a project. `projectId` must be known —
   * folders are project-scoped and there is no project-free folder namespace.
   */
  async resolve(
    projectId: string,
    declaration: FolderDeclaration,
  ): Promise<ResolvedFolderAssignment | null> {
    if (!declaration.declared) return null;
    if (declaration.parentFolderId !== undefined) {
      // Raw ID from the file: trust it. There is nothing to resolve — and on
      // a server that cannot read folders back, this is the only handle the
      // file has.
      return { parentFolderId: declaration.parentFolderId, created: [] };
    }

    const segments = declaration.path === null ? [] : splitFolderPath(declaration.path);
    if (segments.length === 0) {
      return { parentFolderId: null, created: [] };
    }

    const index = await this.indexFor(projectId);

    // Walk/create segment by segment so the caches stay authoritative.
    let parentId: string | null = null;
    const created: string[] = [];
    for (const segment of segments) {
      const existing = [...index.values()].find(
        (f) => f.name === segment && folderParentId(f) === parentId,
      );
      if (existing) {
        parentId = existing.id;
        continue;
      }
      if (this.opts.createMissing === false) {
        throw new FolderResolutionError(
          `folder "${segments.join("/")}" does not exist in project ${projectId} ` +
            "(create it in the n8n UI, or allow folder creation by not passing --no-create-missing-folders)",
        );
      }
      if (this.opts.dryRun) {
        // Preview: report the creation without performing it. The synthetic
        // ID keeps the walk going for deeper segments.
        created.push(segment);
        const synthetic: Folder = {
          id: `dry-run:${[...created].join("/")}`,
          name: segment,
          parentFolderId: parentId,
        };
        index.set(synthetic.id, synthetic);
        parentId = synthetic.id;
        continue;
      }
      const folder = await this.folderService.createFolder(projectId, {
        name: segment,
        ...(parentId ? { parentFolderId: parentId } : {}),
      });
      index.set(folder.id, folder);
      created.push(segment);
      parentId = folder.id;
    }

    return { parentFolderId: parentId, created };
  }

  /** Maps a folder ID to its path within a project (for reporting). */
  async pathFor(projectId: string, folderId: string | null): Promise<string | null> {
    if (!folderId) return null;
    // A synthetic ID from a dry-run plan already *is* the path.
    if (folderId.startsWith("dry-run:")) return folderId.slice("dry-run:".length);
    await this.indexFor(projectId);
    return this.pathCache.get(projectId)?.get(folderId) ?? folderId;
  }

  /** Loads (or reuses) the folder index of a project. */
  private async indexFor(projectId: string): Promise<Map<string, Folder>> {
    const cached = this.indexCache.get(projectId);
    if (cached) return cached;

    const folders = await this.folderService.listAllFolders(projectId);
    const { byId, pathById } = buildFolderIndex(folders);
    this.indexCache.set(projectId, byId);
    this.pathCache.set(projectId, pathById);
    return byId;
  }
}

// ---------------------------------------------------------------------------
// folders.yaml — folder trees as code
// ---------------------------------------------------------------------------

export interface FolderTreeNode {
  name: string;
  folders?: FolderTreeNode[];
}

export interface FolderProjectSection {
  /** Owning project. Omit when a default project is supplied at apply time. */
  projectId?: string;
  folders?: FolderTreeNode[];
}

export interface FoldersConfig {
  projects: FolderProjectSection[];
}

/** Candidate file names for the folder-tree definition, in priority order. */
export const FOLDERS_CONFIG_FILENAMES = ["folders.yaml", "folders.yml", "folders.json"] as const;

/**
 * True when a filename is a folder-tree definition, not a workflow.
 *
 * Scanners must skip these: `folders.yaml` sits inside the definitions
 * directory next to real workflows, and a scanner that treats every `.yaml`
 * as a workflow would either report it as a broken definition (apply) or
 * delete it as an orphan (import --cleanup-orphans).
 */
export function isFoldersConfigFile(filename: string): boolean {
  return (FOLDERS_CONFIG_FILENAMES as readonly string[]).includes(path.basename(filename));
}

/** Thrown for a malformed folders.yaml. */
export class FoldersConfigError extends Error {
  constructor(
    message: string,
    public readonly file?: string,
  ) {
    super(message);
    this.name = "FoldersConfigError";
  }
}

/** Loads `folders.yaml` (or `.yml`/`.json`) from a directory; null when absent. */
export function loadFoldersConfig(
  directory: string,
): { config: FoldersConfig; file: string } | null {
  for (const name of FOLDERS_CONFIG_FILENAMES) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf-8");
    let parsed: unknown;
    if (name.endsWith(".json")) {
      parsed = JSON.parse(raw);
    } else {
      try {
        parsed = yaml.load(raw);
      } catch (err) {
        throw new FoldersConfigError(
          `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
          file,
        );
      }
    }
    return { config: validateFoldersConfig(parsed, file), file };
  }
  return null;
}

/** Validates and normalises a parsed folders.yaml document. */
export function validateFoldersConfig(parsed: unknown, file?: string): FoldersConfig {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FoldersConfigError("expected a top-level object with a `projects` array", file);
  }
  const doc = parsed as Record<string, unknown>;
  const projectsRaw = doc.projects;
  if (projectsRaw === undefined) {
    throw new FoldersConfigError("missing `projects` array", file);
  }
  if (!Array.isArray(projectsRaw)) {
    throw new FoldersConfigError("`projects` must be an array", file);
  }

  const projects: FolderProjectSection[] = [];
  for (const [i, entry] of projectsRaw.entries()) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new FoldersConfigError(`projects[${i}] must be an object`, file);
    }
    const section = entry as Record<string, unknown>;
    if (section.projectId !== undefined && typeof section.projectId !== "string") {
      throw new FoldersConfigError(`projects[${i}].projectId must be a string`, file);
    }
    const folders =
      section.folders === undefined
        ? []
        : validateFolderNodes(section.folders, `projects[${i}].folders`, file);
    projects.push({
      ...(typeof section.projectId === "string" ? { projectId: section.projectId } : {}),
      folders,
    });
  }

  return { projects };
}

function validateFolderNodes(raw: unknown, where: string, file?: string): FolderTreeNode[] {
  if (!Array.isArray(raw)) {
    throw new FoldersConfigError(`${where} must be an array`, file);
  }
  const nodes: FolderTreeNode[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new FoldersConfigError(`${where}[${i}] must be an object with a \`name\``, file);
    }
    const node = entry as Record<string, unknown>;
    if (typeof node.name !== "string" || node.name.trim() === "") {
      throw new FoldersConfigError(`${where}[${i}].name must be a non-empty string`, file);
    }
    const name = node.name.trim();
    if (name.includes("/") || name.includes("\\")) {
      throw new FoldersConfigError(
        `${where}[${i}].name must be a single folder name without "/" ("${name}") — nest via the \`folders\` key`,
        file,
      );
    }
    if (ROOT_MARKERS.has(name.toLowerCase())) {
      throw new FoldersConfigError(`${where}[${i}].name "${name}" is a reserved root marker`, file);
    }
    if (seen.has(name)) {
      throw new FoldersConfigError(`${where} declares "${name}" twice`, file);
    }
    seen.add(name);
    const children =
      node.folders === undefined
        ? []
        : validateFolderNodes(node.folders, `${where}[${i}].folders`, file);
    nodes.push({ name, ...(children.length > 0 ? { folders: children } : {}) });
  }
  return nodes;
}

/** Report of one folders.yaml sync. */
export interface FolderSyncReport {
  /** Folder paths created, in creation order, qualified by project. */
  created: Array<{ projectId: string; path: string }>;
  /** Paths that already existed and were left alone. */
  existing: Array<{ projectId: string; path: string }>;
  /** Sections skipped because no project could be determined. */
  skipped: Array<{ reason: string }>;
}

/**
 * Ensures every folder path in a folders.yaml tree exists, creating missing
 * folders parent-first.
 *
 * Reconciliation is deliberately add-only: folders cannot carry client-chosen
 * IDs, so renames and moves cannot be expressed reliably as code and are not
 * attempted — deleting or moving upstream folders is done in the UI (or the
 * `folder` command), not by apply.
 */
export async function syncFolderTree(
  folderService: FolderService,
  config: FoldersConfig,
  opts: { defaultProjectId?: string; dryRun?: boolean },
): Promise<FolderSyncReport> {
  const report: FolderSyncReport = { created: [], existing: [], skipped: [] };

  const unresolved = config.projects.filter((p) => !p.projectId).length;
  if (unresolved > 1) {
    throw new FoldersConfigError(
      "folders.yaml has multiple project sections without projectId — add projectId to each",
    );
  }

  for (const section of config.projects) {
    const projectId = section.projectId ?? opts.defaultProjectId ?? "";
    if (!projectId) {
      report.skipped.push({
        reason:
          "folder section has no projectId and no default project is set (pass -p/--project or set defaultProjectId)",
      });
      continue;
    }

    // One list per project; walk the tree creating only what is missing.
    const folders = opts.dryRun ? null : await folderService.listAllFolders(projectId);
    const index = folders ? buildFolderIndex(folders).byId : new Map<string, Folder>();

    const walk = async (nodes: FolderTreeNode[], parentId: string | null, prefix: string) => {
      for (const node of nodes) {
        const nodePath = prefix ? `${prefix}/${node.name}` : node.name;
        const existing = [...index.values()].find(
          (f) => f.name === node.name && folderParentId(f) === parentId,
        );
        if (existing) {
          report.existing.push({ projectId, path: nodePath });
          await walk(node.folders ?? [], existing.id, nodePath);
          continue;
        }
        if (opts.dryRun) {
          report.created.push({ projectId, path: nodePath });
          // Keep walking children against a synthetic parent so the whole
          // missing subtree is reported.
          const syntheticId = `dry-run:${nodePath}`;
          index.set(syntheticId, { id: syntheticId, name: node.name, parentFolderId: parentId });
          await walk(node.folders ?? [], syntheticId, nodePath);
          continue;
        }
        const folder = await folderService.createFolder(projectId, {
          name: node.name,
          ...(parentId ? { parentFolderId: parentId } : {}),
        });
        index.set(folder.id, folder);
        report.created.push({ projectId, path: nodePath });
        await walk(node.folders ?? [], folder.id, nodePath);
      }
    };

    await walk(section.folders ?? [], null, "");
  }

  return report;
}
