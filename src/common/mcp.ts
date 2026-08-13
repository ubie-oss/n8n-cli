/**
 * How n8n picks the trigger it enters a workflow through over MCP, and the
 * glob used to write policy about it.
 *
 * Shared because the proxy gate and the `mcp-exposure` lint rule must agree
 * exactly: CI passing and the gate refusing the same workflow would be worse
 * than either check alone. One definition, two callers.
 */

/**
 * Trigger node types n8n will start an MCP execution from.
 *
 * A mirror of `findMcpSupportedTrigger` in n8n
 * (`packages/cli/src/modules/mcp/mcp.utils.ts`). Manual triggers are omitted:
 * n8n accepts them only for `executionMode: "manual"`, and resolving a
 * different entry than a production run would use is worse than resolving none.
 *
 * **This is a coupling.** If n8n adds a supported trigger type, a workflow
 * whose new-type trigger sorts earlier is entered somewhere this release does
 * not predict. It lives here, in one place, to be revisited on n8n upgrades.
 */
export const MCP_ENTRY_TRIGGER_TYPES: readonly string[] = [
  "n8n-nodes-base.scheduleTrigger",
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.formTrigger",
  "@n8n/n8n-nodes-langchain.chatTrigger",
];

/** The trigger n8n would start an MCP execution from. */
export interface EntryTrigger {
  name: string;
  type: string;
  /**
   * `parameters.path`, when the node carries one.
   *
   * Schedule triggers never do. A webhook or form node that never had one set
   * does not either — n8n falls back to the node's `webhookId`, a UUID that no
   * path convention should be written against.
   */
  path?: string;
  /**
   * The trigger's own parameters, as n8n stores them.
   *
   * Carried so a caller can be told what to send without reading the workflow:
   * a Form trigger's `formFields` and a Webhook's `httpMethod` both live here,
   * and they are what `execute_workflow`'s `inputs` argument has to match.
   */
  parameters?: Record<string, unknown>;
}

/** The shape this needs from a node; deliberately looser than `Node`. */
export interface EntryTriggerNode {
  name?: unknown;
  type?: unknown;
  disabled?: unknown;
  parameters?: { path?: unknown } | null;
}

/**
 * Resolves the trigger n8n would fire, using n8n's own rule: the first
 * non-disabled node of a supported type, **in array order**.
 *
 * Array order is not incidental — it is the entire mechanism, and it is stable:
 * n8n stores `nodes` as JSON and nothing in its save path reorders it, so the
 * order a definition is written in is the order this sees.
 */
export function findEntryTrigger(
  nodes: readonly EntryTriggerNode[] | undefined,
): EntryTrigger | null {
  for (const node of nodes ?? []) {
    if (node.disabled === true) continue;
    if (typeof node.type !== "string" || !MCP_ENTRY_TRIGGER_TYPES.includes(node.type)) continue;
    const path = node.parameters?.path;
    const parameters = node.parameters;
    return {
      name: typeof node.name === "string" ? node.name : "",
      type: node.type,
      ...(typeof path === "string" && path !== "" ? { path } : {}),
      ...(typeof parameters === "object" && parameters !== null
        ? { parameters: parameters as Record<string, unknown> }
        : {}),
    };
  }
  return null;
}

/**
 * Matches a `*`-glob against a value.
 *
 * Deliberately not a regex from the operator: these patterns are matched
 * against names and paths that arrive from upstream, and a config typo
 * producing a catastrophically backtracking pattern would be a denial of
 * service on whatever is doing the matching.
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
