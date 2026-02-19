import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "../api/types.ts";
import { hasAllTags } from "../common/tags.ts";
import { Detector } from "../git/detector.ts";
import { extractWorkflowIDFromDirname, extractWorkflowIDFromFilename } from "../naming/naming.ts";
import { loadYamlWorkflow } from "../yaml/loader.ts";
import type { ApplyOptions, WorkflowFile } from "./types.ts";

/** Scanner handles scanning and parsing workflow files from a directory. */
export class Scanner {
  /**
   * ScanWithOptions scans workflow files based on ApplyOptions configuration.
   * When IDs filter is provided, it filters files BEFORE checking for duplicates.
   */
  async scanWithOptions(opts: ApplyOptions): Promise<WorkflowFile[]> {
    const yamlEnabled = opts.yamlEnabled && !opts.noYaml;

    let files: WorkflowFile[];

    if (opts.fromGitChanges) {
      files = await this.scanFromGitChanges(opts, yamlEnabled);
    } else {
      files = await this.scanDirectory(opts.directory, yamlEnabled);
    }

    // Filter by IDs BEFORE checking for duplicates
    if (opts.ids.length > 0) {
      files = filterByIDs(files, opts.ids);
    }

    // Filter by tags (AND condition)
    if (opts.filterByTags.length > 0) {
      files = filterByTags(files, opts.filterByTags);
    }

    // Check for duplicate workflow IDs
    const dupError = checkDuplicateIDs(files);
    if (dupError) {
      throw dupError;
    }

    return files;
  }

  /** Scans a directory recursively for workflow files. */
  async scanDirectory(dir: string, yamlEnabled: boolean): Promise<WorkflowFile[]> {
    if (!fs.existsSync(dir)) {
      throw new Error(`directory not found: ${dir}`);
    }
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`not a directory: ${dir}`);
    }

    const files: WorkflowFile[] = [];
    await this.walkDirectory(dir, yamlEnabled, files);
    return files;
  }

  private async walkDirectory(
    dir: string,
    yamlEnabled: boolean,
    files: WorkflowFile[],
  ): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip _subfiles directories (they contain external files, not workflows)
        if (entry.name === "_subfiles") continue;
        await this.walkDirectory(fullPath, yamlEnabled, files);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".json") {
          files.push(this.parseJSONFile(fullPath));
        } else if (ext === ".yaml" || ext === ".yml") {
          if (yamlEnabled) {
            files.push(this.parseYAMLFile(fullPath));
          }
        }
      }
    }
  }

  /** Reads and parses a single workflow JSON file. */
  private parseJSONFile(filePath: string): WorkflowFile {
    const wf: WorkflowFile = { path: filePath, sourceType: "json" };
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      const workflow: Workflow = JSON.parse(data);
      this.validateWorkflow(workflow);
      this.checkIDMismatch(filePath, workflow);
      wf.workflow = workflow;
    } catch (err) {
      wf.error = err instanceof Error ? err : new Error(String(err));
    }
    return wf;
  }

  /** Parses a YAML workflow file. */
  private parseYAMLFile(filePath: string): WorkflowFile {
    const wf: WorkflowFile = { path: filePath, sourceType: "yaml" };
    try {
      const workflow = loadYamlWorkflow(filePath);
      this.validateWorkflow(workflow);
      this.checkIDMismatch(filePath, workflow);
      wf.workflow = workflow;
    } catch (err) {
      wf.error = err instanceof Error ? err : new Error(String(err));
    }
    return wf;
  }

  /** Scans workflow files from git diff output. */
  private async scanFromGitChanges(
    opts: ApplyOptions,
    yamlEnabled: boolean,
  ): Promise<WorkflowFile[]> {
    const detector = new Detector();
    const changedFiles = await detector.getChangedFiles(opts.gitDiffSpec, "");

    const absDir = path.resolve(opts.directory);
    const repoRoot = await detector.getRepoRoot();

    // Build workflowID → filePath map for reverse lookup (for external files)
    const workflowIDToFile = new Map<string, string>();
    if (yamlEnabled) {
      try {
        const allFiles = await this.scanDirectory(absDir, true);
        for (const wf of allFiles) {
          if (wf.workflow?.id && wf.sourceType === "yaml") {
            workflowIDToFile.set(wf.workflow.id, wf.path);
          }
        }
      } catch {
        // Continue without reverse lookup capability
      }
    }

    const processedFiles = new Set<string>();
    const files: WorkflowFile[] = [];

    for (const relPath of changedFiles) {
      const absPath = path.join(repoRoot, relPath);

      // Check if file is under opts.Directory
      const relToDir = path.relative(absDir, absPath);
      if (relToDir.startsWith("..")) continue;

      // Check if file exists (might be deleted)
      if (!fs.existsSync(absPath)) continue;

      const ext = path.extname(absPath).toLowerCase();

      if (ext === ".json") {
        if (!processedFiles.has(absPath)) {
          processedFiles.add(absPath);
          files.push(this.parseJSONFile(absPath));
        }
        continue;
      }

      if ((ext === ".yaml" || ext === ".yml") && yamlEnabled) {
        if (!processedFiles.has(absPath)) {
          processedFiles.add(absPath);
          files.push(this.parseYAMLFile(absPath));
        }
        continue;
      }

      // External files under _subfiles/ - reverse lookup to parent
      if (yamlEnabled) {
        const workflowID = extractWorkflowIDFromSubfilePath(absPath);
        if (workflowID) {
          const parentPath = workflowIDToFile.get(workflowID);
          if (parentPath && !processedFiles.has(parentPath)) {
            processedFiles.add(parentPath);
            files.push(this.parseYAMLFile(parentPath));
          }
        }
      }
    }

    return files;
  }

  /** Validates a workflow has minimum required fields. */
  private validateWorkflow(w: Workflow): void {
    if (!w.name) throw new Error("workflow name is required");
    if (w.nodes == null) throw new Error("workflow nodes field is required");
    if (w.connections == null) throw new Error("workflow connections field is required");
  }

  /** Checks for ID mismatch between filename and JSON content. */
  private checkIDMismatch(filePath: string, workflow: Workflow): void {
    const [filenameID, ok] = extractWorkflowIDFromFilename(filePath);
    if (ok && workflow.id && filenameID !== workflow.id) {
      console.error(
        `Warning: ${filePath}: filename ID (${filenameID}) does not match JSON ID (${workflow.id}), using JSON ID`,
      );
    }
  }
}

/** Checks for duplicate workflow IDs among files. */
function checkDuplicateIDs(files: WorkflowFile[]): Error | null {
  const idToFiles = new Map<string, string[]>();
  for (const f of files) {
    if (!f.workflow?.id) continue;
    const paths = idToFiles.get(f.workflow.id) ?? [];
    paths.push(f.path);
    idToFiles.set(f.workflow.id, paths);
  }

  for (const [id, paths] of idToFiles) {
    if (paths.length > 1) {
      const fileList = paths.map((p) => `    - ${p}`).join("\n");
      return new Error(
        `duplicate workflow ID: ${id}\n  Files:\n${fileList}\n  Hint: Remove one of the files or use different workflow IDs`,
      );
    }
  }

  return null;
}

/** Filters workflow files to only include those with matching IDs. */
function filterByIDs(files: WorkflowFile[], ids: string[]): WorkflowFile[] {
  const idSet = new Set(ids.map((id) => id.trim()));
  return files.filter((wf) => wf.workflow?.id && idSet.has(wf.workflow.id));
}

/** Filters workflow files to only include those with ALL specified tags (AND condition). */
function filterByTags(files: WorkflowFile[], tags: string[]): WorkflowFile[] {
  return files.filter((wf) => {
    if (!wf.workflow) return false;
    return hasAllTags(wf.workflow.tags, tags);
  });
}

/** Extracts workflowID from a _subfiles path. */
function extractWorkflowIDFromSubfilePath(filePath: string): string | null {
  const normalized = filePath.split(path.sep).join("/");
  const idx = normalized.indexOf("_subfiles/");
  if (idx === -1) return null;

  const remainder = normalized.slice(idx + "_subfiles/".length);
  const slashIdx = remainder.indexOf("/");
  if (slashIdx === -1) return null;

  const dirname = remainder.slice(0, slashIdx);
  const [id, ok] = extractWorkflowIDFromDirname(dirname);
  return ok ? id : null;
}
