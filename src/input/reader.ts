import type { Workflow, WorkflowInput } from "@/api/types.ts";
import { detectWorkflowFormat } from "@/common/extensions.ts";
import { loadTsWorkflow } from "@/ts/loader.ts";

/**
 * Reads workflow input from a file or stdin.
 * If filename is "-" or empty, reads from stdin.
 */
export async function readWorkflowInput(filename: string): Promise<WorkflowInput> {
  const fromFile = readTsFile(filename);
  if (fromFile) {
    validateWorkflowInput(fromFile);
    return fromFile;
  }

  const data = await readData(filename);

  if (data.length === 0) {
    throw new Error("empty input");
  }

  const input: WorkflowInput = JSON.parse(data);
  validateWorkflowInput(input);

  return input;
}

/**
 * Loads a workflow from a `.ts` file, or returns null for anything else.
 *
 * YAML is deliberately not handled here: these entry points have always been
 * JSON-or-stdin, and widening them further is a separate change.
 */
function readTsFile(filename: string): Workflow | null {
  if (filename === "" || filename === "-") return null;
  if (detectWorkflowFormat(filename) !== "ts") return null;
  return loadTsWorkflow(filename);
}

/**
 * Reads a full workflow from a file or stdin.
 * Used for imports where we want the full workflow structure.
 */
export async function readWorkflowFull(filename: string): Promise<Workflow> {
  const fromFile = readTsFile(filename);
  if (fromFile) return fromFile;

  const data = await readData(filename);

  if (data.length === 0) {
    throw new Error("empty input");
  }

  const workflow: Workflow = JSON.parse(data);
  return workflow;
}

/** Validates the workflow input has required fields. */
export function validateWorkflowInput(input: WorkflowInput): void {
  if (!input.name) {
    throw new Error("workflow name is required");
  }
  if (input.nodes == null) {
    throw new Error("workflow nodes are required");
  }
  if (input.connections == null) {
    throw new Error("workflow connections are required");
  }
}

/** Reads raw data from a file or stdin. */
async function readData(filename: string): Promise<string> {
  if (filename === "" || filename === "-") {
    // Read from stdin
    const chunks: Uint8Array[] = [];
    const reader = Bun.stdin.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const decoder = new TextDecoder();
    return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  }

  // Read from file using Bun.file()
  const file = Bun.file(filename);
  return await file.text();
}
