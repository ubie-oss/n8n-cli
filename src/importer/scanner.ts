import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { Workflow } from "@/api/types.ts";
import { detectWorkflowFormat } from "@/common/extensions.ts";
import { extractWorkflowIDFromFilename } from "@/naming/naming.ts";
import { loadTsWorkflow } from "@/ts/loader.ts";
import { loadYamlWorkflow } from "@/yaml/loader.ts";
import { OrphanFileMap, type SourceType, WorkflowIDMap } from "./types.ts";

/**
 * Permissive schema that treats `!include` tags as plain strings.
 * Used for lightweight ID/name extraction without resolving file includes.
 */
const permissiveIncludeType = new yaml.Type("!include", {
  kind: "scalar",
  resolve: () => true,
  construct: (data: string) => `!include ${data}`,
});
const permissiveSchema = yaml.DEFAULT_SCHEMA.extend([permissiveIncludeType]);

/**
 * Scans a directory recursively for workflow JSON and YAML files.
 * Returns a WorkflowIDMap containing workflow ID → file path mappings.
 */
export function scanDirectory(dir: string, tsEnabled = false): WorkflowIDMap {
  const idMap = new WorkflowIDMap();

  if (!fs.existsSync(dir)) {
    return idMap;
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }

  walkDir(dir, (filePath) => {
    if (!isWorkflowCandidate(filePath)) return;
    const id = extractWorkflowID(filePath, tsEnabled);
    if (id) idMap.add(id, filePath);
  });

  return idMap;
}

/** True when a path is a workflow file this scan should read. */
function isWorkflowCandidate(filePath: string): boolean {
  return detectWorkflowFormat(filePath) != null;
}

/**
 * Scans a directory recursively for workflow files, returning both
 * a WorkflowIDMap (files with IDs) and an OrphanFileMap (files without IDs).
 */
export function scanDirectoryWithOrphans(
  dir: string,
  tsEnabled = false,
): [WorkflowIDMap, OrphanFileMap] {
  const idMap = new WorkflowIDMap();
  const orphanMap = new OrphanFileMap();

  if (!fs.existsSync(dir)) {
    return [idMap, orphanMap];
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }

  walkDir(dir, (filePath) => {
    if (!isWorkflowCandidate(filePath)) return;

    const [id, name] = extractIDAndName(filePath, tsEnabled);
    const sourceType = detectWorkflowFormat(filePath) as SourceType;
    if (id) {
      // Files with an ID are always indexed, whatever their format. Skipping
      // `.ts` here would hide an existing file from the format-preservation
      // check in the importer, and it would write a second file alongside it.
      idMap.add(id, filePath);
    } else if (name) {
      // Orphans are what `--cleanup-orphans` deletes, so an ID-less `.ts` only
      // counts as one when the caller asked to manage `.ts` at all.
      if (sourceType !== "ts" || tsEnabled) {
        orphanMap.add({ path: filePath, name, sourceType });
      }
    }
  });

  return [idMap, orphanMap];
}

/** Parses a workflow JSON/YAML/TS file and returns the full Workflow object. */
export function parseWorkflowFile(filePath: string): Workflow {
  switch (detectWorkflowFormat(filePath)) {
    case "yaml":
      return loadYamlWorkflow(filePath);
    case "ts":
      return loadTsWorkflow(filePath);
    default: {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as Workflow;
    }
  }
}

/** Walk a directory recursively, skipping underscore-prefixed dirs. */
function walkDir(dir: string, callback: (filePath: string, entry: fs.Dirent) => void): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip underscore-prefixed directories (e.g., _subfiles)
      if (entry.name.startsWith("_")) continue;
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath, entry);
    }
  }
}

/** Extracts the workflow ID from a JSON/YAML/TS file by parsing the `id` field. */
function extractWorkflowID(filePath: string, tsEnabled: boolean): string {
  return extractIDAndName(filePath, tsEnabled)[0];
}

/** Extracts both ID and name from a JSON/YAML/TS file. */
function extractIDAndName(filePath: string, tsEnabled: boolean): [string, string] {
  let rawId: unknown;
  let rawName: unknown;
  try {
    [rawId, rawName] = readIdAndNameFields(filePath);
  } catch (err) {
    return [idFromUnreadableFile(filePath, err, tsEnabled), ""];
  }

  const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
  const name = typeof rawName === "string" ? rawName : "";

  if (id) {
    // Check filename ID mismatch
    const [filenameID, found] = extractWorkflowIDFromFilename(filePath);
    if (found && filenameID !== id) {
      console.error(
        `Warning: ${filePath}: filename ID (${filenameID}) does not match file ID (${id}), using file ID`,
      );
    }
  }

  return [id, name];
}

/**
 * Recovers the workflow ID of a `.ts` file that failed to parse, from its
 * filename.
 *
 * Without this a broken `.ts` workflow simply disappears from the scan, and
 * `import` happily writes a second file for the same workflow — leaving the user
 * with a duplicate and no explanation. Falling back to the filename keeps the
 * slot occupied; the warning says why the file was not read.
 *
 * Limited to `.ts` on purpose: unreadable JSON and YAML have always been skipped
 * silently, and changing that is a separate decision. It also only applies when
 * ts mode is on — otherwise an ordinary TypeScript file that happens to be named
 * `utils__abc123.ts` would be claimed as the workflow `abc123`, and import would
 * overwrite it with whatever the server has under that ID.
 */
function idFromUnreadableFile(filePath: string, err: unknown, tsEnabled: boolean): string {
  if (!tsEnabled) return "";
  if (detectWorkflowFormat(filePath) !== "ts") return "";

  const [filenameID, found] = extractWorkflowIDFromFilename(filePath);
  if (!found) return "";

  console.error(
    `Warning: ${filePath}: could not be parsed (${err instanceof Error ? err.message : String(err)}); ` +
      `using the ID from its filename (${filenameID})`,
  );
  return filenameID;
}

/**
 * Reads the raw `id` and `name` fields out of a workflow file.
 *
 * JSON and YAML are parsed shallowly — YAML with a permissive schema so that
 * unresolved `!include` tags do not fail the read. TypeScript has no shallow
 * form, so the file is loaded through the SDK; anything that is not a workflow
 * throws and is reported as an empty pair by the callers.
 */
function readIdAndNameFields(filePath: string): [unknown, unknown] {
  if (detectWorkflowFormat(filePath) === "ts") {
    const workflow = loadTsWorkflow(filePath);
    return [workflow.id, workflow.name];
  }

  const data = fs.readFileSync(filePath, "utf-8");
  const parsed = (
    detectWorkflowFormat(filePath) === "yaml"
      ? yaml.load(data, { schema: permissiveSchema })
      : JSON.parse(data)
  ) as Record<string, unknown>;

  return [parsed?.id, parsed?.name];
}
