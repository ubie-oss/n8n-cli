import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "../api/types.ts";
import { extractWorkflowIDFromFilename } from "../naming/naming.ts";
import { parseTsWorkflow } from "../ts/loader.ts";
import { loadYamlWorkflow } from "../yaml/loader.ts";

/**
 * Loads a workflow from a file on disk. Format is decided by extension:
 * `.json` (server export), `.yaml`/`.yml` (definitions), `.ts` (workflow-sdk).
 */
export function loadWorkflowFile(filePath: string): Workflow {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".json":
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Workflow;
    case ".yaml":
    case ".yml":
      return loadYamlWorkflow(filePath, { stripFileHeaders: true });
    case ".ts":
      return parseTsWorkflow(fs.readFileSync(filePath, "utf-8"), fallbackID(filePath));
    default:
      throw new Error(`unsupported workflow file extension: ${filePath}`);
  }
}

/**
 * Parses workflow content held in memory. `virtualPath` only decides the
 * format (by extension) and the fallback workflow ID; nothing is read from
 * disk, so content fetched with `git show` can go through the same path.
 */
export function loadWorkflowContent(content: string, virtualPath: string): Workflow {
  const ext = path.extname(virtualPath).toLowerCase();
  switch (ext) {
    case ".json":
      return JSON.parse(content) as Workflow;
    case ".yaml":
    case ".yml": {
      // Content held in memory (e.g. fetched with `git show`) has no directory
      // for `!include` refs to resolve against, so it is loaded through a temp
      // mirror of the file name.
      return loadYamlFromTempMirror(content, virtualPath);
    }
    case ".ts":
      return parseTsWorkflow(content, fallbackID(virtualPath));
    default:
      throw new Error(`unsupported workflow file extension: ${virtualPath}`);
  }
}

/**
 * Writes YAML to a temp location before loading so `!include` refs resolve
 * relative to a real directory. Callers comparing files on disk do not need
 * this; it exists for content retrieved from a git ref.
 */
export function loadYamlFromTempMirror(content: string, virtualPath: string): Workflow {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-"));
  const target = path.join(tmpDir, path.basename(virtualPath));
  fs.writeFileSync(target, content);
  try {
    return loadYamlWorkflow(target, { stripFileHeaders: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function fallbackID(filePath: string): string {
  const [id] = extractWorkflowIDFromFilename(filePath);
  return id || "00000000-0000-4000-8000-000000000000";
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface PairedSide {
  workflow?: Workflow;
  source?: string;
}

/**
 * Pairs left/right workflows into comparisons. Identity is the workflow ID
 * first; leftovers without an ID are paired by exact name, which covers
 * hand-written definitions that never carried one.
 */
export function pairWorkflows(
  left: Array<{ workflow: Workflow; source?: string }>,
  right: Array<{ workflow: Workflow; source?: string }>,
): Array<{ left?: PairedSide; right?: PairedSide }> {
  const pairs: Array<{ left?: PairedSide; right?: PairedSide }> = [];
  const usedRight = new Set<number>();

  const rightById = new Map<string, number>();
  right.forEach((r, i) => {
    if (r.workflow.id != null) rightById.set(r.workflow.id, i);
  });

  for (const l of left) {
    const id = l.workflow.id;
    let ri: number | undefined;
    if (id != null) ri = rightById.get(id);
    if (ri === undefined && id == null) {
      ri = right.findIndex((r, i) => !usedRight.has(i) && r.workflow.name === l.workflow.name);
    }
    if (ri !== undefined && !usedRight.has(ri)) {
      pairs.push({ left: { workflow: l.workflow, source: l.source }, right: { ...right[ri] } });
      usedRight.add(ri);
    } else {
      pairs.push({ left: { workflow: l.workflow, source: l.source } });
    }
  }

  right.forEach((r, i) => {
    if (!usedRight.has(i)) {
      pairs.push({ right: { workflow: r.workflow, source: r.source } });
    }
  });

  return pairs;
}
