import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { connectionsEqual, nodesEqual, pinDataEqual } from "@/apply/differ.ts";
import {
  extractWorkflowIDFromDirname,
  generateDirnameWithID,
  generateFilenameWithID,
} from "@/naming/naming.ts";
import { generateTsWorkflow } from "@/ts/generator.ts";
import { parseTsWorkflow } from "@/ts/loader.ts";
import { generateYamlWorkflow, SubfilesDir, sanitizeNodeName } from "@/yaml/generator.ts";

/** Maximum filename length in bytes. */
const MaxFilenameBytes = 200;

/** Standard filename for workflow description files. */
const DescriptionFilename = "description.md";

/** Sanitizes a workflow name to a safe filename. */
export function sanitizeFilename(name: string): string {
  if (!name) return "unnamed";

  let result = name;

  // 1. Replace & with -and-
  result = result.replaceAll("&", "-and-");

  // 2. Remove invalid filesystem characters
  for (const ch of ["*", "?", '"', "<", ">", "#", "）", ")"]) {
    result = result.replaceAll(ch, "");
  }

  // 3. Replace separator characters with hyphens
  for (const ch of [" ", "\u3000", "/", "\\", ":", "|", "→", "（", "(", "、", ","]) {
    result = result.replaceAll(ch, "-");
  }

  // 4. Compress consecutive hyphens
  result = result.replace(/-+/g, "-");

  // 5. Trim leading/trailing hyphens
  result = result.replace(/^-+|-+$/g, "");

  // 6. Fallback
  if (!result) return "unnamed";

  // 7. Truncate to max 200 bytes
  const encoder = new TextEncoder();
  if (encoder.encode(result).length > MaxFilenameBytes) {
    let truncated = result;
    while (encoder.encode(truncated).length > MaxFilenameBytes) {
      truncated = truncated.slice(0, -1);
    }
    result = truncated;
  }

  // 8. Lowercase
  return result.toLowerCase();
}

/** Generates the file path for a new JSON workflow file. */
export function generateFilePath(
  directory: string,
  workflowID: string,
  workflowName: string,
): string {
  const sanitized = sanitizeFilename(workflowName);
  const filename = generateFilenameWithID(sanitized, workflowID, ".json");
  return path.join(directory, filename);
}

/** Generates the file path for a new TypeScript workflow file. */
export function generateTsFilePath(
  directory: string,
  workflowID: string,
  workflowName: string,
): string {
  const sanitized = sanitizeFilename(workflowName);
  const filename = generateFilenameWithID(sanitized, workflowID, ".ts");
  return path.join(directory, filename);
}

/** Generates the file path for a new YAML workflow file. */
export function generateYamlFilePath(
  directory: string,
  workflowID: string,
  workflowName: string,
): string {
  const sanitized = sanitizeFilename(workflowName);
  const filename = generateFilenameWithID(sanitized, workflowID, ".yaml");
  return path.join(directory, filename);
}

/** Ensures the directory exists, creating it if necessary. */
export function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Writes data to a file atomically using temp file + rename. */
function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  ensureDirectory(dir);

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data);

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/** Writes a workflow as formatted JSON. */
export function writeWorkflowJSON(filePath: string, workflow: Workflow): void {
  ensureDirectory(path.dirname(filePath));
  const data = `${JSON.stringify(workflow, null, 2)}\n`;
  writeFileAtomic(filePath, data);
}

/**
 * Writes a workflow as a `.ts` file written against `@n8n/workflow-sdk`.
 *
 * The generated file is parsed back and compared against the source before it is
 * written. `.ts` is a lossier format than JSON — the SDK models workflows as a
 * builder graph, not as arbitrary JSON — so a workflow it cannot represent
 * faithfully must fail loudly here rather than silently become the wrong file.
 */
export function writeWorkflowTS(filePath: string, workflow: Workflow): void {
  const code = generateTsWorkflow(workflow);

  const mismatch = describeRoundTripMismatch(workflow, code);
  if (mismatch) {
    throw new Error(
      `workflow cannot be represented as TypeScript without loss (${mismatch}). ` +
        "Import this workflow as JSON or YAML instead.",
    );
  }

  ensureDirectory(path.dirname(filePath));
  writeFileAtomic(filePath, code);
}

/**
 * Parses generated code back and reports the first field that does not survive
 * the round trip, or null when the workflow round-trips cleanly.
 *
 * Node IDs are excluded from the comparison on purpose: the `.ts` format has no
 * field for them, so the loader derives them from node names and `apply` adopts
 * the remote's IDs (see `ts/node-ids.ts` and `apply/executor.ts`).
 */
function describeRoundTripMismatch(workflow: Workflow, code: string): string | null {
  let parsed: Workflow;
  try {
    parsed = parseTsWorkflow(code, workflow.id ?? "");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (parsed.name !== workflow.name) return "name";
  if (!nodesEqual(stripNodeIDs(parsed.nodes), stripNodeIDs(workflow.nodes))) return "nodes";
  if (!connectionsEqual(parsed.connections, workflow.connections)) return "connections";
  if (!pinDataEqual(parsed.pinData, workflow.pinData)) return "pinData";

  return null;
}

/** Copies nodes with the `id` field removed, for ID-insensitive comparison. */
function stripNodeIDs(nodes: Workflow["nodes"] | undefined): Workflow["nodes"] {
  return (nodes ?? []).map(({ id: _id, ...rest }) => rest as Workflow["nodes"][number]);
}

/**
 * Writes a workflow as YAML format with external files.
 * Returns list of written file paths (YAML file first, then external files).
 */
export function writeWorkflowYAML(
  directory: string,
  existingPath: string | null,
  workflow: Workflow,
  threshold: number,
): string[] {
  if (!workflow.id) {
    throw new Error("workflow ID is required for YAML export");
  }

  // Determine YAML file path
  const yamlPath = existingPath ?? generateYamlFilePath(directory, workflow.id, workflow.name);

  // Use the YAML generator
  const { yamlPath: writtenPath, externalFilePaths } = generateYamlWorkflow(
    workflow,
    directory,
    yamlPath,
    threshold,
  );

  // Write description.md if it doesn't exist
  const extDir = createExternalFilesDirectory(directory, workflow.id, workflow.name);
  const descPath = writeDescriptionTemplate(extDir, workflow);

  const allPaths = [writtenPath, ...externalFilePaths];
  if (descPath) allPaths.push(descPath);

  return allPaths;
}

/** Creates the directory for external files. */
function createExternalFilesDirectory(
  baseDir: string,
  workflowID: string,
  workflowName: string,
): string {
  const sanitized = sanitizeNodeName(workflowName);
  const dirName = generateDirnameWithID(sanitized, workflowID);
  const extDir = path.join(baseDir, SubfilesDir, dirName);
  ensureDirectory(extDir);
  return extDir;
}

/** Writes a description.md template if it doesn't already exist. */
function writeDescriptionTemplate(extDir: string, workflow: Workflow): string | null {
  const descPath = path.join(extDir, DescriptionFilename);

  if (fs.existsSync(descPath)) {
    return null;
  }

  const content = generateDescriptionTemplate(workflow);
  if (!content) return null;

  writeFileAtomic(descPath, content);
  return descPath;
}

/** Generates a description.md template for a workflow. */
function generateDescriptionTemplate(workflow: Workflow): string {
  const lines: string[] = [];

  lines.push(`# ${workflow.name}`);
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push("<!-- Describe the purpose and functionality of this workflow -->");
  lines.push("");
  lines.push("## Status");
  lines.push("");
  lines.push("- State: In Development");
  lines.push("- Owner: @your-slack-id");
  lines.push("");
  lines.push("## Input Parameters");
  lines.push("");

  const inputs = extractWorkflowInputs(workflow);
  if (inputs.length > 0) {
    lines.push("| Parameter | Type | Required | Description | Example |");
    lines.push("|-----------|------|----------|-------------|---------|");
    for (const input of inputs) {
      const required = input.required ? "Yes" : "No";
      lines.push(
        `| ${input.name} | ${input.type} | ${required} | <!-- description --> | \`<!-- example -->\` |`,
      );
    }
  } else {
    lines.push("<!-- Fill in the table below if there are input parameters -->");
    lines.push("");
    lines.push("| Parameter | Type | Required | Description | Example |");
    lines.push("|-----------|------|----------|-------------|---------|");
    lines.push("| example | string | Yes | Example parameter | `value` |");
  }

  lines.push("");
  lines.push("## Testing");
  lines.push("");
  lines.push("```bash");
  if (inputs.length > 0) {
    lines.push(`n8n-cli test ${workflow.id} -d '{`);
    for (let i = 0; i < inputs.length; i++) {
      const comma = i < inputs.length - 1 ? "," : "";
      lines.push(`  "${inputs[i]?.name}": "<!-- value -->"${comma}`);
    }
    lines.push("}' --wait-execution");
  } else {
    lines.push(`n8n-cli test ${workflow.id} --wait-execution`);
  }
  lines.push("```");
  lines.push("");
  lines.push("## Dependencies");
  lines.push("");
  lines.push("<!-- Describe sub-workflow and external service dependencies -->");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("<!-- Describe limitations, known issues, and caveats -->");
  lines.push("");

  return lines.join("\n");
}

interface WorkflowInputParam {
  name: string;
  type: string;
  required: boolean;
}

/** Extracts input parameters from an executeWorkflowTrigger node. */
function extractWorkflowInputs(workflow: Workflow): WorkflowInputParam[] {
  for (const node of workflow.nodes) {
    if (node.type !== "n8n-nodes-base.executeWorkflowTrigger") continue;
    if (!node.parameters) continue;

    const wfInputs = node.parameters.workflowInputs as Record<string, unknown> | undefined;
    if (!wfInputs) continue;

    const values = wfInputs.values as unknown[] | undefined;
    if (!Array.isArray(values)) continue;

    const inputs: WorkflowInputParam[] = [];
    for (const v of values) {
      if (v == null || typeof v !== "object") continue;
      const valMap = v as Record<string, unknown>;
      const name = typeof valMap.name === "string" ? valMap.name : "";
      const type = typeof valMap.type === "string" ? valMap.type : "string";
      if (name) {
        inputs.push({ name, type, required: true });
      }
    }
    return inputs;
  }

  return [];
}

/** Returns the _subfiles directory path for a workflow. */
export function getSubfilesDir(baseDir: string, workflowID: string, workflowName: string): string {
  const sanitized = sanitizeNodeName(workflowName);
  const dirName = generateDirnameWithID(sanitized, workflowID);
  return path.join(baseDir, SubfilesDir, dirName);
}

/**
 * Finds an existing _subfiles/ subdirectory matching the given workflow ID.
 * Returns the full path if found, or null otherwise.
 */
export function findExistingSubfilesDir(baseDir: string, workflowID: string): string | null {
  const dirs = findExistingSubfilesDirs(baseDir, workflowID);
  return dirs.length > 0 ? dirs[0]! : null;
}

/**
 * Finds all existing _subfiles/ subdirectories matching the given workflow ID.
 * Returns an array of full paths (may be empty).
 */
export function findExistingSubfilesDirs(baseDir: string, workflowID: string): string[] {
  const subfilesPath = path.join(baseDir, SubfilesDir);
  if (!fs.existsSync(subfilesPath)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(subfilesPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const [id, found] = extractWorkflowIDFromDirname(entry.name);
    if (found && id === workflowID) {
      result.push(path.join(subfilesPath, entry.name));
    }
  }

  return result;
}

/** Embeds a workflow ID into an existing JSON file. */
export function embedWorkflowID(filePath: string, workflowID: string): void {
  const data = fs.readFileSync(filePath, "utf-8");
  const workflow = JSON.parse(data) as Record<string, unknown>;

  if (typeof workflow.id === "string" && workflow.id) {
    throw new Error(`ID already exists in JSON file: ${workflow.id}`);
  }

  workflow.id = workflowID;
  const newData = `${JSON.stringify(workflow, null, 2)}\n`;
  writeFileAtomic(filePath, newData);
}
