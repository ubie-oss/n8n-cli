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
 * tag that says which workflows are agent-reachable — evaluated in front of n8n
 * where an author cannot change it.
 *
 * Deliberately *not* configurable: whether the target must also have
 * `settings.availableInMCP`. n8n already refuses `execute_workflow` and
 * `get_workflow_details` for a workflow without it, so re-checking here would
 * add a flag and no enforcement.
 */

/** Tools that act on one workflow, and the argument naming it. */
export type WorkflowIdArgs = Record<string, string[]>;

/**
 * The n8n MCP tools that target a single workflow, and where the id lives.
 *
 * Names and the `workflowId` parameter are taken from n8n's own tool
 * definitions (`packages/cli/src/modules/mcp/tools/`), not from its docs — the
 * docs name several of these differently. `id` stays as a fallback for a
 * version that renames the parameter.
 *
 * A fixed table rather than an option, because it is not the only line of
 * defence: `scanForWorkflowIds` separately checks *every* argument value
 * against the set of workflow ids that exist upstream. So a tool n8n renames,
 * or one this release has never heard of, cannot smuggle a forbidden workflow
 * id past the gate — the table only decides how precise the refusal message is,
 * and whether a call that names no workflow at all is refused.
 */
export const WORKFLOW_ID_ARGS: WorkflowIdArgs = {
  execute_workflow: ["workflowId", "id"],
  test_workflow: ["workflowId", "id"],
  prepare_workflow_pin_data: ["workflowId", "id"],
  get_workflow_details: ["workflowId", "id"],
  get_workflow_history: ["workflowId", "id"],
  get_workflow_version: ["workflowId", "id"],
  restore_workflow_version: ["workflowId", "id"],
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
}

/** True when the policy says nothing about which workflows are reachable. */
export function hasWorkflowScope(policy: McpPolicy): boolean {
  return policy.workflowTags.length > 0;
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
 * Returns `undefined` when the tool is not known to target a workflow (nothing
 * precise to say), and `null` when it is but the call named none — which is
 * refused rather than waved through, because a mapped tool with no target is a
 * malformed call, not a broad one.
 */
export function targetWorkflowId(
  tool: string,
  args: Record<string, unknown>,
): string | null | undefined {
  const names = WORKFLOW_ID_ARGS[tool];
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
 * Every value anywhere in a tool call's arguments that names a workflow this
 * instance actually has.
 *
 * The backstop behind {@link WORKFLOW_ID_ARGS}. The argument names in that table
 * were read off n8n's docs, not off the running server, and n8n adds MCP tools
 * between releases — so the gate must not depend on having guessed right. Any
 * argument value that *is* an upstream workflow id gets checked against the
 * policy, whatever the tool is called and whatever the parameter is named.
 *
 * Walks nested objects and arrays: a filter or a batch request buries the id
 * one level down, and a check that only read the top level would miss it.
 */
export function scanForWorkflowIds(args: unknown, known: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();

  const walk = (value: unknown, depth: number): void => {
    // Bounded so a pathological payload cannot spin the gate.
    if (depth > 8) return;
    if (typeof value === "string" || typeof value === "number") {
      const candidate = String(value);
      if (known.has(candidate)) found.add(candidate);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };

  walk(args, 0);
  return found;
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
