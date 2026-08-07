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
export function scanDirectory(dir: string): WorkflowIDMap {
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
    const id = extractWorkflowID(filePath);
    if (id) idMap.add(id, filePath);
  });

  return idMap;
}

/**
 * True when a path has an extension we can read a workflow out of.
 *
 * `.d.ts` files are excluded: they are type declarations, never workflows.
 */
function isWorkflowCandidate(filePath: string): boolean {
  if (filePath.toLowerCase().endsWith(".d.ts")) return false;
  return detectWorkflowFormat(filePath) != null;
}

/**
 * Scans a directory recursively for workflow files, returning both
 * a WorkflowIDMap (files with IDs) and an OrphanFileMap (files without IDs).
 */
export function scanDirectoryWithOrphans(dir: string): [WorkflowIDMap, OrphanFileMap] {
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

    const [id, name] = extractIDAndName(filePath);
    const sourceType = detectWorkflowFormat(filePath) as SourceType;
    if (id) {
      idMap.add(id, filePath);
    } else if (name) {
      orphanMap.add({ path: filePath, name, sourceType });
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
function extractWorkflowID(filePath: string): string {
  try {
    const [rawId] = readIdAndNameFields(filePath);
    const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
    if (id) {
      // Check filename ID mismatch
      const [filenameID, found] = extractWorkflowIDFromFilename(filePath);
      if (found && filenameID !== id) {
        console.error(
          `Warning: ${filePath}: filename ID (${filenameID}) does not match file ID (${id}), using file ID`,
        );
      }
      return id;
    }
  } catch {
    // Silently skip unparseable files
  }
  return "";
}

/** Extracts both ID and name from a JSON/YAML/TS file. */
function extractIDAndName(filePath: string): [string, string] {
  try {
    const [rawId, rawName] = readIdAndNameFields(filePath);
    const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
    const name = typeof rawName === "string" ? rawName : "";
    return [id, name];
  } catch {
    return ["", ""];
  }
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
