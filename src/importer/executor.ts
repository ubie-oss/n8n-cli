import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import type { ListOptions, WorkflowService } from "@/api/workflow-service.ts";
import { hasAllTags } from "@/common/tags.ts";
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
  generateYamlFilePath,
  getSubfilesDir,
  writeWorkflowJSON,
  writeWorkflowYAML,
} from "./writer.ts";

/** ImportExecutor orchestrates the import process. */
export class ImportExecutor {
  private progressCallback: ProgressCallback | null = null;

  constructor(
    private readonly workflowService: WorkflowService,
    private readonly opts: ImportOptions,
  ) {}

  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /** Runs the full import process. */
  async execute(): Promise<ImportResultClass> {
    const startTime = Date.now();
    const result = new ImportResultClass();

    // Ensure definitions directory exists
    ensureDirectory(this.opts.directory);

    // Scan local directory
    const [idMap, orphanMap] = scanDirectoryWithOrphans(this.opts.directory);

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
        this.processWorkflow(workflow, idMap, result);
      }

      if (!resp.nextCursor) break;
      opts.cursor = resp.nextCursor;

      if (processed >= estimatedTotal) {
        estimatedTotal = processed + 100;
      }
    }
  }

  /** Handles a single workflow import. */
  private processWorkflow(remote: Workflow, idMap: WorkflowIDMap, result: ImportResultClass): void {
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

    // Determine format: preserve existing format, or use yamlEnabled for new
    let useYaml = false;
    if (exists) {
      const lowerPath = targetPath.toLowerCase();
      useYaml = lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml");
    } else {
      useYaml = this.opts.yamlEnabled;
    }

    // Compute expected path under current naming rules
    const expectedPath = useYaml
      ? generateYamlFilePath(this.opts.directory, remote.id, remote.name)
      : generateFilePath(this.opts.directory, remote.id, remote.name);
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
    } else if (!exists && useYaml) {
      targetPath = generateYamlFilePath(this.opts.directory, remote.id, remote.name);
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
