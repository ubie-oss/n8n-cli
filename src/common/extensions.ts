/** Supported workflow file extensions */
export const WORKFLOW_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".ts"]);

/** The on-disk formats a workflow definition can be stored in. */
export type WorkflowFormat = "json" | "yaml" | "ts";

/**
 * Maps a file path to its workflow format, or null when the extension is not one
 * n8n-cli handles.
 */
export function detectWorkflowFormat(filePath: string): WorkflowFormat | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts")) return "ts";
  return null;
}
