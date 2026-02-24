import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { WORKFLOW_EXTENSIONS } from "@/common/extensions.ts";
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
