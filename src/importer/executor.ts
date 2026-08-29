import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import type { ListOptions, WorkflowService } from "@/api/workflow-service.ts";
import { detectWorkflowFormat, type WorkflowFormat } from "@/common/extensions.ts";
import { hasAllTags } from "@/common/tags.ts";
import type { FolderInfo, McpFolderSource } from "./folder-source.ts";
import { cleanupOrphanFiles, cleanupOrphanSubfiles, matchOrphansByName } from "./orphan.ts";
import { reportDuplicates } from "./reporter.ts";
import { parseWorkflowFile, scanDirectoryWithOrphans } from "./scanner.ts";
import {
  type ImportOptions,
  ImportResult as ImportResultClass,
  type ProgressCallback,
  type WorkflowIDMap,
} from "./types.ts";
import {
  ensureDirectory,
  findExistingSubfilesDirs,
  generateFilePath,
  generateTsFilePath,
  generateYamlFilePath,
  getSubfilesDir,
  writeWorkflowJSON,
  writeWorkflowTS,
  writeWorkflowYAML,
} from "./writer.ts";

/** Resolves the on-disk path a workflow gets in a given format. */
function pathForFormat(
  format: WorkflowFormat,
  directory: string,
  workflowID: string,
  workflowName: string,
): string {
  switch (format) {
    case "yaml":
      return generateYamlFilePath(directory, workflowID, workflowName);
    case "ts":
      return generateTsFilePath(directory, workflowID, workflowName);
    default:
      return generateFilePath(directory, workflowID, workflowName);
  }
}

/** ImportExecutor orchestrates the import process. */
export class ImportExecutor {
  private progressCallback: ProgressCallback | null = null;
  private folderSource?: McpFolderSource;

  constructor(
    private readonly workflowService: WorkflowService,
    private readonly opts: ImportOptions,
  ) {}

  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /**
   * SetFolderSource enables folder assignment on imported files. The source
   * talks to n8n's MCP server (directly, or through a proxy that injects the
   * MCP token); without one, the public API's write-only `parentFolderId`
   * makes the information unavailable and import behaves exactly as before.
   */
  setFolderSource(source: McpFolderSource): void {
    this.folderSource = source;
  }

  /** Runs the full import process. */
  async execute(): Promise<ImportResultClass> {
    const startTime = Date.now();
    const result = new ImportResultClass();

    // Ensure definitions directory exists
    ensureDirectory(this.opts.directory);

    // Scan local directory
    const [idMap, orphanMap] = scanDirectoryWithOrphans(this.opts.directory, this.opts.tsEnabled);

    // Track orphan paths
    for (const orphan of orphanMap.all()) {
      result.orphans.push(orphan.path);
    }

    // Report duplicates
    if (idMap.hasDuplicates()) {
      reportDuplicates(idMap.duplicates());
    }

    // Fetch and process remote workflows
    const remoteNameMap = new Map<string, Workflow[]>();
    await this.processRemoteWorkflows(idMap, result, remoteNameMap);

    // Match orphans by name
    if (orphanMap.count() > 0 && remoteNameMap.size > 0) {
      matchOrphansByName(orphanMap, remoteNameMap, this.opts.dryRun, result);
    }

    // Cleanup orphans
    if (this.opts.cleanupOrphans && orphanMap.count() > 0) {
      cleanupOrphanFiles(orphanMap, this.opts.dryRun, result);
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /** Fetches and processes all remote workflows with streaming pagination. */
  private async processRemoteWorkflows(
    idMap: WorkflowIDMap,
    result: ImportResultClass,
    remoteNameMap: Map<string, Workflow[]>,
  ): Promise<void> {
    const opts: ListOptions = { limit: 100 };
    let processed = 0;
    let estimatedTotal = 0;
    const eligible: Workflow[] = [];

    for (;;) {
      const resp = await this.workflowService.listWorkflows(opts);

      if (estimatedTotal === 0) {
        estimatedTotal = resp.data.length;
        if (resp.nextCursor) {
          estimatedTotal = resp.data.length * 2;
        }
      }

      for (const workflow of resp.data) {
        // Skip if IDs filter is set and this ID isn't included
        if (this.opts.ids.length > 0 && !this.opts.ids.includes(workflow.id ?? "")) {
          continue;
        }

        // Skip if tag filter is set and doesn't match
        if (
          this.opts.filterByTags.length > 0 &&
          !hasAllTags(workflow.tags, this.opts.filterByTags)
        ) {
          continue;
        }

        eligible.push(workflow);
      }

      if (!resp.nextCursor) break;
      opts.cursor = resp.nextCursor;

      if (processed >= estimatedTotal) {
        estimatedTotal = processed + 100;
      }
    }

    // Folder info needs the whole eligible set at once: the bulk MCP search
    // is per instance, and folder ID → path resolution is per project. Built
    // once before the per-workflow loop; failure degrades to no folder info.
    let folderInfo: FolderInfo | undefined;
    if (this.folderSource) {
      try {
        folderInfo = await this.folderSource.buildFolderInfo(eligible);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (this.opts.mcpStrict) {
          throw new Error(`failed to read folder assignments over MCP: ${message}`);
        }
        console.warn(
          `Warning: folder information unavailable (MCP: ${message}) — importing without folder assignments`,
        );
      }
    }

    for (const workflow of eligible) {
      processed++;
      result.totalRemote++;

      // Track name for orphan matching
      if (workflow.name) {
        const existing = remoteNameMap.get(workflow.name) ?? [];
        existing.push(workflow);
        remoteNameMap.set(workflow.name, existing);
      }

      // Report progress
      if (this.progressCallback) {
        this.progressCallback(processed, estimatedTotal, workflow.name, "create");
      }

      // Process individual workflow
      this.processWorkflow(workflow, idMap, result, folderInfo);
    }
  }

  /** Handles a single workflow import. */
  private processWorkflow(
    remote: Workflow,
    idMap: WorkflowIDMap,
    result: ImportResultClass,
    folderInfo?: FolderInfo,
  ): void {
    // Skip archived unless included
    if (!this.opts.includeArchived && remote.isArchived === true) {
      result.addOperation({
        workflowID: remote.id ?? "",
        workflowName: remote.name,
        type: "skip",
        localPath: "",
        reason: "workflow is archived",
      });
      return;
    }

    // Skip empty ID
    if (!remote.id) {
      result.addOperation({
        workflowID: "",
        workflowName: remote.name,
        type: "error",
        localPath: "",
        reason: "workflow has empty ID",
      });
      return;
    }

    // Attach the folder assignment when the MCP source resolved one. The
    // public API never reports it, so this only ever fires with a folder
    // source present. A workflow absent from the map is left untouched —
    // "unknown", not "project root" — and the local file keeps whatever
    // declaration it already had.
    if (folderInfo) {
      const parentFolderId = folderInfo.folderByWorkflow.get(remote.id);
      if (parentFolderId !== undefined) {
        remote.parentFolderId = parentFolderId;
        remote.folder =
          parentFolderId === null
            ? null
            : (folderInfo.pathById.get(parentFolderId) ?? parentFolderId);
      }
    }

    // Check duplicate — warn but continue (use first file from idMap)
    const dups = idMap.duplicates();
    if (dups.has(remote.id)) {
      const dupPaths = dups.get(remote.id)!;
      console.error(`Warning: duplicate local files for ${remote.id}:`);
      for (const p of dupPaths) {
        console.error(`    - ${p}`);
      }
      // fall through to idMap.get() which returns the first file
    }

    // Check if exists locally
    const [localPath, exists] = idMap.get(remote.id);
    let targetPath = localPath;

    // Determine format: preserve the existing file's format, otherwise fall back
    // to the format requested on the command line.
    const format: WorkflowFormat = exists
      ? (detectWorkflowFormat(targetPath) ?? "json")
      : this.opts.tsEnabled
        ? "ts"
        : this.opts.yamlEnabled
          ? "yaml"
          : "json";
    const useYaml = format === "yaml";

    // Compute expected path under current naming rules
    const expectedPath = pathForFormat(format, this.opts.directory, remote.id, remote.name);
    const needsRename = exists && path.resolve(localPath) !== path.resolve(expectedPath);

    if (exists) {
      // Check timestamps
      try {
        const localWorkflow = parseWorkflowFile(targetPath);
        if (!shouldUpdate(localWorkflow.updatedAt, remote.updatedAt) && !needsRename) {
          result.addOperation({
            workflowID: remote.id,
            workflowName: remote.name,
            type: "skip",
            localPath: targetPath,
            reason: "local is newer or equal",
          });
          return;
        }
      } catch {
        // Can't read local file, treat as update
      }
    } else {
      // New workflow
      targetPath = expectedPath;
    }

    // If renaming, update targetPath to the expected path
    if (needsRename) {
      targetPath = expectedPath;
    }

    const opType = exists ? (needsRename ? "rename" : "update") : "create";

    // Write (unless dry-run)
    if (!this.opts.dryRun) {
      try {
        // BEFORE write: save old subfiles directory paths for later cleanup
        const oldSubfilesDirs = needsRename
          ? findExistingSubfilesDirs(this.opts.directory, remote.id)
          : [];

        if (useYaml) {
          const written = writeWorkflowYAML(
            this.opts.directory,
            needsRename ? null : exists ? localPath : null,
            remote,
            this.opts.externalizeThreshold,
          );
          if (written.length > 0) {
            targetPath = written[0]!;
          }

          // Cleanup orphan subfiles if enabled
          if (this.opts.cleanupSubfiles) {
            const subfilesDir = getSubfilesDir(this.opts.directory, remote.id, remote.name);
            cleanupOrphanSubfiles(subfilesDir, written, this.opts.dryRun, result);
          }
        } else if (format === "ts") {
          writeWorkflowTS(targetPath, remote);
        } else {
          writeWorkflowJSON(targetPath, remote);
        }

        // If renaming, delete the old file and old _subfiles directories
        if (needsRename) {
          try {
            fs.unlinkSync(localPath);
          } catch {
            // old file may already be gone
          }
          const newSubfilesDir = getSubfilesDir(this.opts.directory, remote.id, remote.name);
          for (const oldDir of oldSubfilesDirs) {
            if (path.resolve(oldDir) !== path.resolve(newSubfilesDir)) {
              try {
                fs.rmSync(oldDir, { recursive: true, force: true });
              } catch {
                // ignore cleanup failure
              }
            }
          }
        }
      } catch (err) {
        result.addOperation({
          workflowID: remote.id,
          workflowName: remote.name,
          type: "error",
          localPath: targetPath,
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    } else if (useYaml && this.opts.cleanupSubfiles && exists && !needsRename) {
      // dry-run: report all non-description.md subfiles as potential orphans
      const subfilesDir = getSubfilesDir(this.opts.directory, remote.id!, remote.name);
      cleanupOrphanSubfiles(subfilesDir, [], true, result);
    } else if (!exists) {
      targetPath = pathForFormat(format, this.opts.directory, remote.id, remote.name);
    }

    result.addOperation({
      workflowID: remote.id,
      workflowName: remote.name,
      type: opType,
      localPath: targetPath,
      oldPath: needsRename ? localPath : undefined,
      reason: "",
    });
  }
}

/** Determines if the local file should be updated based on timestamps. */
function shouldUpdate(local: string | undefined, remote: string | undefined): boolean {
  if (!local) return true;
  if (!remote) return false;

  const localDate = new Date(local);
  const remoteDate = new Date(remote);
  return remoteDate.getTime() > localDate.getTime();
}
