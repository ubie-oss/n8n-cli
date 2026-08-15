import type { AccessLevel } from "./roles.ts";

/** MCP tools that mutate a workflow or run it — editor or above. */
const MCP_WRITE_TOOLS = new Set([
  "execute_workflow",
  "test_workflow",
  "prepare_test_pin_data",
  "prepare_workflow_pin_data",
  "update_workflow",
  "publish_workflow",
  "unpublish_workflow",
  "archive_workflow",
  "restore_workflow_version",
  "create_workflow_from_code",
]);

/** MCP tools that only read workflow state — viewer or above. */
const MCP_READ_TOOLS = new Set([
  "get_workflow_details",
  "get_workflow_history",
  "get_workflow_version",
]);

/**
 * Maps an MCP tool name to the project access level it needs.
 *
 * Returns `undefined` when the tool is not workflow-scoped (for example
 * `search_workflows`) and this gate has nothing to decide.
 */
export function mcpToolAccessLevel(tool: string): AccessLevel | undefined {
  if (MCP_WRITE_TOOLS.has(tool)) return "write";
  if (MCP_READ_TOOLS.has(tool)) return "read";
  return undefined;
}
