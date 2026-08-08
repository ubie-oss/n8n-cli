import fs from "node:fs";
import { parseWorkflowCodeToBuilder } from "@n8n/workflow-sdk";
import type { Node, Workflow } from "@/api/types.ts";
import { extractWorkflowIDFromFilename } from "@/naming/naming.ts";
import { stableNodeIdMap } from "./node-ids.ts";
import { preprocessTsWorkflow, TsPreprocessError } from "./preprocess.ts";

export interface LoadTsOptions {
  /**
   * The workflow as it currently exists elsewhere (on disk, or upstream). Node
   * IDs present here are reused, so converting a JSON workflow to `.ts` does not
   * churn every node ID. See `ts/node-ids.ts`.
   */
  existing?: Workflow;
}

/** Error thrown when a `.ts` workflow file cannot be loaded. */
export class TsLoadError extends Error {
  constructor(filePath: string, message: string) {
    super(`failed to load TypeScript workflow "${filePath}": ${message}`);
    this.name = "TsLoadError";
  }
}

/**
 * Parses SDK workflow code into a Workflow.
 *
 * Exported separately from {@link loadTsWorkflow} so callers holding code in
 * memory (tests, round-trip verification) do not need a file on disk.
 */
export function parseTsWorkflow(
  source: string,
  fallbackID: string,
  options?: LoadTsOptions,
): Workflow {
  const { code, meta } = preprocessTsWorkflow(source);

  const builder = parseWorkflowCodeToBuilder(code);

  // The SDK mints random node IDs on every parse. Prefer the IDs recorded in the
  // metadata block, fall back to IDs derived from the workflow ID and node name
  // for hand-written files that have none — either way they are stable, so a
  // workflow does not look changed on every apply.
  const workflowID = builder.id || fallbackID;
  const names = builder
    .toJSON()
    .nodes.map((n) => n.name)
    .filter((n): n is string => typeof n === "string");
  builder.regenerateNodeIds(stableNodeIdMap(workflowID, names, options?.existing, meta.nodeIds));

  const json = builder.toJSON();

  const workflow: Workflow = {
    name: json.name,
    active: meta.active ?? options?.existing?.active ?? false,
    nodes: json.nodes as unknown as Node[],
    connections: json.connections as Workflow["connections"],
  };

  const id = json.id || fallbackID;
  if (id) workflow.id = id;
  // `toJSON()` always returns a settings object, empty when the workflow has no
  // settings. Passing that empty object on would make apply send `settings: {}`
  // and wipe whatever the server has.
  if (json.settings && Object.keys(json.settings).length > 0) {
    workflow.settings = json.settings as Workflow["settings"];
  }
  if (json.pinData) workflow.pinData = json.pinData as unknown as Workflow["pinData"];
  if (meta.description !== undefined) workflow.description = meta.description;
  if (meta.folderPath !== undefined) workflow.folderPath = meta.folderPath;
  if (meta.folderId !== undefined) workflow.folderId = meta.folderId;
  if (meta.isArchived !== undefined) workflow.isArchived = meta.isArchived;
  if (meta.tags) workflow.tags = meta.tags.map((name) => ({ id: "", name }));
  if (meta.updatedAt) workflow.updatedAt = meta.updatedAt;

  return workflow;
}

/**
 * Reads and parses a `.ts` workflow file written against `@n8n/workflow-sdk`.
 *
 * The workflow ID comes from the `workflow(id, name)` call; when that is empty
 * the ID encoded in the filename is used, matching how JSON and YAML files
 * behave.
 */
export function loadTsWorkflow(filePath: string, options?: LoadTsOptions): Workflow {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TsLoadError(filePath, msg);
  }

  const [filenameID] = extractWorkflowIDFromFilename(filePath);

  try {
    return parseTsWorkflow(source, filenameID, options);
  } catch (err) {
    if (err instanceof TsPreprocessError || err instanceof SyntaxError) {
      throw new TsLoadError(filePath, err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new TsLoadError(filePath, msg);
  }
}
