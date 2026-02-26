import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { WORKFLOW_EXTENSIONS } from "@/common/extensions.ts";
import { hasAllTags } from "@/common/tags.ts";
import { loadYamlWorkflow } from "@/yaml/loader.ts";

/** Scan walks a directory tree and returns all workflow files (.json, .yaml, .yml) */
export function scanFiles(dir: string): string[] {
  const files: string[] = [];
  walkDir(dir, files);
  return files;
}

function walkDir(dir: string, files: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip _subfiles directories (they contain external files, not workflows)
      if (entry.name === "_subfiles") continue;
      walkDir(fullPath, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (WORKFLOW_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }
}

/** Result of loading a lint file */
export interface LintFileResult {
  rawJSON: string;
  workflow: Workflow | null;
}

/**
 * Loads a workflow file for linting, supporting JSON and YAML formats.
 *
 * @throws Error for YAML parse errors (this format must be valid)
 * @returns For JSON files, returns null workflow on parse error (allows raw JSON linting)
 */
export async function loadLintFile(filePath: string): Promise<LintFileResult> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    const workflow = loadYamlWorkflow(filePath) as Workflow;
    const rawJSON = JSON.stringify(workflow);
    return { rawJSON, workflow };
  }

  // Default: JSON
  const rawJSON = fs.readFileSync(filePath, "utf-8");
  let workflow: Workflow | null = null;
  try {
    workflow = JSON.parse(rawJSON) as Workflow;
  } catch {
    // JSON parse failed - some rules can still run with rawJSON
  }
  return { rawJSON, workflow };
}

/**
 * Loads a workflow file without resolving `!include` tags.
 * Useful for extracting metadata (tags, name) when `!include` targets are missing.
 * For JSON files, behaves identically to `loadLintFile`.
 */
export async function loadLintFileWithoutIncludes(filePath: string): Promise<LintFileResult> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    const workflow = loadYamlWorkflow(filePath, { resolveIncludes: false }) as Workflow;
    const rawJSON = JSON.stringify(workflow);
    return { rawJSON, workflow };
  }

  // JSON: same as loadLintFile
  return loadLintFile(filePath);
}

/** Outcome of loading a file for linting with tag filter fallback. */
export type LintLoadOutcome =
  | { status: "loaded"; data: LintFileResult }
  | { status: "skipped"; message: string }
  | { status: "error"; message: string };

/**
 * Loads a workflow file for linting, with tag filter fallback.
 *
 * If loading fails and a tag filter is active, attempts to load without
 * `!include` resolution to check tags. If tags don't match the filter,
 * the file is skipped (returned as "skipped" with a warning message)
 * instead of being reported as an error.
 */
export async function loadFileForLint(
  filePath: string,
  filterByTags: string[],
): Promise<LintLoadOutcome> {
  try {
    return { status: "loaded", data: await loadLintFile(filePath) };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);

    if (filterByTags.length > 0) {
      try {
        const fallback = await loadLintFileWithoutIncludes(filePath);
        if (fallback.workflow && !hasAllTags(fallback.workflow.tags, filterByTags)) {
          return {
            status: "skipped",
            message: `Failed to read file (skipped by tag filter): ${errMsg}`,
          };
        }
      } catch {
        // Fallback also failed → fall through to error
      }
    }

    return { status: "error", message: `Failed to read file: ${errMsg}` };
  }
}
