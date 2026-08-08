import path from "node:path";
import yaml from "js-yaml";
import type { Workflow } from "@/api/types.ts";
import { createIncludeSchema, resolveIncludeRefs } from "./include-schema.ts";

export interface LoadYamlOptions {
  /** When true (default), `!include` refs are resolved to file contents. When false, `IncludeRef` objects are preserved. */
  resolveIncludes?: boolean;
  /** When true, strip n8n-cli-generated file headers from included file contents. */
  stripFileHeaders?: boolean;
}

/**
 * Loads a YAML workflow file, optionally resolving `!include` tags relative to the file's directory.
 * Returns a parsed Workflow object.
 */
export function loadYamlWorkflow(filePath: string, options?: LoadYamlOptions): Workflow {
  const absPath = path.resolve(filePath);
  const baseDir = path.dirname(absPath);
  const resolveIncludes = options?.resolveIncludes ?? true;

  let content: string;
  try {
    content = require("node:fs").readFileSync(absPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read YAML file "${filePath}": ${msg}`);
  }

  const schema = createIncludeSchema(baseDir);

  let parsed: unknown;
  try {
    parsed = yaml.load(content, { schema, filename: absPath });
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      throw new Error(`YAML parse error in "${filePath}": ${err.message}`);
    }
    throw err;
  }

  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`YAML file "${filePath}" did not produce a valid object`);
  }

  normalizeTimestamps(parsed as Record<string, unknown>);

  if (resolveIncludes) {
    const stripHeaders = options?.stripFileHeaders ?? false;
    parsed = resolveIncludeRefs(parsed, baseDir, { stripFileHeaders: stripHeaders });
  }

  return parsed as Workflow;
}

/**
 * Forces the workflow-level timestamps back to strings, in place.
 *
 * YAML's implicit typing turns an unquoted ISO timestamp into a `Date`, and
 * `Workflow.updatedAt` is declared — and consumed — as a string: conflict
 * detection compares it, and `apply` sends it upstream as a header. It must run
 * before `resolveIncludeRefs`, which walks objects with `Object.entries` and so
 * flattens any `Date` it meets into `{}`, destroying the value outright.
 *
 * Files written by `import` quote the value and are unaffected. This is for the
 * hand-edited ones.
 */
function normalizeTimestamps(parsed: Record<string, unknown>): void {
  for (const key of ["createdAt", "updatedAt"]) {
    const value = parsed[key];
    if (value instanceof Date) {
      parsed[key] = value.toISOString();
    }
  }
}
