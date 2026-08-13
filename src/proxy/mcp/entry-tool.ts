/**
 * `get_workflow_entry` — a small tool the proxy answers itself.
 *
 * n8n's `execute_workflow` tells the model to call `get_workflow_details`
 * first, and it has to: `inputs` is a union discriminated by trigger type
 * (`chat` / `form` / `webhook`), nothing in `search_workflows` says which one a
 * workflow takes, and picking wrong makes n8n execute with empty data rather
 * than fail. So that lookup happens before every execution — and n8n answers it
 * with the whole workflow. Measured against a live instance: 116 KB, of which a
 * caller that only runs workflows reads three fields.
 *
 * This is the additive answer to that. Rather than rewriting n8n's reply — which
 * would make this proxy responsible for a shape it does not own, forever — the
 * gate publishes its own tool beside it. n8n's `get_workflow_details` keeps
 * working exactly as it does; an operator who wants only the small one simply
 * leaves the large one out of `--mcp-allow-tools`.
 *
 * It costs no upstream call: the gate already holds these facts, because it has
 * to resolve the entry trigger to decide reachability at all.
 */

import type { JsonRpcMessage } from "./jsonrpc.ts";
import { isToolAllowed, type McpPolicy } from "./policy.ts";
import type { WorkflowFacts } from "./workflow-index.ts";

export const ENTRY_TOOL_NAME = "get_workflow_entry";

/**
 * Whether this deployment publishes the tool.
 *
 * It has to be named in `--mcp-allow-tools`, not merely allowed by an empty
 * list: a tool appearing in `tools/list` because someone upgraded the proxy is
 * a surprise, and the gate's rule everywhere else is that an upgrade changes
 * nothing until the configuration says so.
 */
export function publishesEntryTool(policy: McpPolicy): boolean {
  return policy.allowTools.length > 0 && isToolAllowed(policy, ENTRY_TOOL_NAME);
}

export const ENTRY_TOOL_DEFINITION = {
  name: ENTRY_TOOL_NAME,
  description:
    "Get what you need to call execute_workflow on a workflow: its description, and the " +
    "trigger n8n would actually enter it through — the type decides which shape of `inputs` " +
    "to build, and the trigger's own parameters carry the details (a form trigger's " +
    "formFields, a webhook's httpMethod). Use this instead of get_workflow_details, which " +
    "returns the entire workflow definition and is far larger than this task needs.",
  inputSchema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "The ID of the workflow to describe" },
    },
    required: ["workflowId"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  },
} as const;

/** The payload for one workflow. */
export function entryPayload(facts: WorkflowFacts): Record<string, unknown> {
  return {
    id: facts.id,
    name: facts.name,
    ...(facts.description === undefined ? {} : { description: facts.description }),
    tags: facts.tags,
    entry:
      facts.entry === null
        ? null
        : {
            name: facts.entry.name,
            type: facts.entry.type,
            ...(facts.entry.path === undefined ? {} : { path: facts.entry.path }),
            parameters: facts.entry.parameters ?? {},
          },
  };
}

/** Builds the reply, in both channels, the way n8n builds its own. */
export function entryToolResult(id: JsonRpcMessage["id"], facts: WorkflowFacts): JsonRpcMessage {
  const payload = entryPayload(facts);
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    },
  };
}
