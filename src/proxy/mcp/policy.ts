/**
 * What an MCP client is allowed to see and do through this proxy.
 *
 * n8n's instance-level MCP server publishes one fixed set of tools — search,
 * execute, publish, archive, workflow authoring, credentials — to every client
 * that authenticates, and `search_workflows` lists every workflow the connecting
 * user can see whether or not it was enabled for MCP. Which is fine as a
 * product default and wrong as an agent's blast radius: the toggle that decides
 * what an agent may run lives in the n8n UI, one click away from anyone with
 * edit rights, and nothing about it is reviewable.
 *
 * This module holds the operator's own answer instead — a tool allowlist, and a
 * rule for which workflows count as agent-reachable — evaluated in front of n8n
 * where an author cannot change it.
 */

/** Tools that act on one workflow, and the argument naming it. */
export type WorkflowIdArgs = Record<string, string[]>;

/**
 * The n8n MCP tools that target a single workflow. `workflowId` first, `id` as
 * the fallback, so a rename upstream degrades to "argument not found" — which,
 * with the default `onMissingTarget: "deny"`, fails closed.
 */
export const DEFAULT_WORKFLOW_ID_ARGS: WorkflowIdArgs = {
  execute_workflow: ["workflowId", "id"],
  test_workflow: ["workflowId", "id"],
  prepare_test_pin_data: ["workflowId", "id"],
  get_workflow_details: ["workflowId", "id"],
  update_workflow: ["workflowId", "id"],
  publish_workflow: ["workflowId", "id"],
  unpublish_workflow: ["workflowId", "id"],
  archive_workflow: ["workflowId", "id"],
};

export interface McpPolicy {
  /**
   * Glob patterns (`*` matches any run of characters) for the tools a client may
   * see and call. When empty every tool is allowed and only `denyTools` applies.
   */
  allowTools: string[];
  /** Glob patterns for tools to withhold. Applied after `allowTools`. */
  denyTools: string[];
  /** Tags a workflow must carry (all of them) to be reachable over MCP. */
  workflowTags: string[];
  /** Regular expression a reachable workflow's name must match. */
  workflowNamePattern?: string;
  /** Whether a workflow must also have `settings.availableInMCP` set. */
  requireAvailableInMCP: boolean;
  /** Per-tool argument names carrying the target workflow id. */
  workflowIdArgs: WorkflowIdArgs;
  /** What to do when a workflow-scoped tool call names no workflow. */
  onMissingTarget: "deny" | "allow";
}

/** True when the policy says nothing about which workflows are reachable. */
export function hasWorkflowScope(policy: McpPolicy): boolean {
  return (
    policy.workflowTags.length > 0 ||
    policy.workflowNamePattern !== undefined ||
    policy.requireAvailableInMCP
  );
}

/** True when the policy says nothing about tools either — a pure passthrough. */
export function isPassthrough(policy: McpPolicy): boolean {
  return (
    policy.allowTools.length === 0 && policy.denyTools.length === 0 && !hasWorkflowScope(policy)
  );
}

/** Whether a tool name survives the allow/deny lists. */
export function isToolAllowed(policy: McpPolicy, name: string): boolean {
  if (policy.allowTools.length > 0 && !policy.allowTools.some((p) => globMatch(p, name))) {
    return false;
  }
  return !policy.denyTools.some((p) => globMatch(p, name));
}

/**
 * The workflow id a `tools/call` targets.
 *
 * Returns `undefined` when the tool is not workflow-scoped at all (nothing to
 * check), and `null` when it is but the call named no workflow — which the
 * caller resolves through `onMissingTarget` rather than waving through.
 */
export function targetWorkflowId(
  policy: McpPolicy,
  tool: string,
  args: Record<string, unknown>,
): string | null | undefined {
  const names = policy.workflowIdArgs[tool];
  if (!names) return undefined;
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value !== "") return value;
    // n8n ids are strings, but a client that sends a number still means one.
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * Matches a `*`-glob against a name.
 *
 * Deliberately not a regex from the operator: these patterns are matched
 * against tool names that arrive from upstream, and a config typo producing a
 * catastrophically backtracking pattern would be a denial of service on the
 * gate itself.
 */
export function globMatch(pattern: string, value: string): boolean {
  return globRegex(pattern).test(value);
}

/** Compiles a `*`-glob to an anchored regex with every other character literal. */
function globRegex(pattern: string): RegExp {
  const escaped = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${escaped}$`);
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
