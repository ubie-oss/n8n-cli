/**
 * Workflow file extensions that any command may read without being asked.
 *
 * `.ts` is deliberately absent. Commands that walk a directory — `lint`, `fmt`,
 * `convert -d` — assume every file they find parses as a workflow, and a
 * repository that keeps workflows as `.ts` is by definition a TypeScript project
 * full of files that do not. Reading `.ts` is opt-in per command; see
 * {@link WORKFLOW_EXTENSIONS_WITH_TS}.
 */
export const WORKFLOW_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

/** Workflow file extensions including `.ts`, for commands that opted in. */
export const WORKFLOW_EXTENSIONS_WITH_TS = new Set([...WORKFLOW_EXTENSIONS, ".ts"]);

/** The on-disk formats a workflow definition can be stored in. */
export type WorkflowFormat = "json" | "yaml" | "ts";

/**
 * Maps a file path to its workflow format, or null when the extension is not one
 * n8n-cli handles.
 *
 * `.d.ts` files are type declarations, never workflows, and are reported as
 * unhandled here so no caller has to remember to exclude them.
 */
export function detectWorkflowFormat(filePath: string): WorkflowFormat | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".d.ts")) return null;
  if (lower.endsWith(".ts")) return "ts";
  return null;
}
