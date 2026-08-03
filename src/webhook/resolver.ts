import type { Node, Workflow } from "../api/types.ts";

/** A webhook node resolved to something callable. */
export interface ResolvedWebhook {
  node: Node;
  path: string;
  httpMethod: string;
  url: string;
}

/** Raised when the named node is absent, disabled, or not a webhook. */
export class WebhookNodeNotFoundError extends Error {
  readonly workflowId: string;
  readonly nodeName: string;

  constructor(workflowId: string, workflowName: string, nodeName: string, reason: string) {
    super(`webhook node "${nodeName}" in workflow "${workflowName}" (${workflowId}): ${reason}`);
    this.name = "WebhookNodeNotFoundError";
    this.workflowId = workflowId;
    this.nodeName = nodeName;
  }
}

/**
 * Resolves a webhook node the caller named, to a URL that can be called.
 *
 * The node is addressed by its exact name and nothing else. This command will
 * not search, guess, or fall back to "the only webhook in the workflow": every
 * webhook in an n8n instance is a live entry point, and some of them are wired
 * to inbound events from other systems. A caller that has to name the node
 * cannot fire one it did not mean to.
 *
 * Which webhooks a given workflow *intends* to expose for manual calls is a
 * policy question, and policies differ per deployment — naming conventions,
 * response modes, auth requirements. This resolver takes no position on any of
 * it; the caller decides what it is willing to call and passes the name.
 */
export function resolveWebhookNode(workflow: Workflow | null, nodeName: string): ResolvedWebhook {
  if (!workflow) throw new Error("workflow is nil");

  const id = workflow.id ?? "";
  const node = workflow.nodes?.find((n) => n.name === nodeName);
  if (!node) {
    throw new WebhookNodeNotFoundError(id, workflow.name, nodeName, "no node with that name");
  }
  if (node.type !== "n8n-nodes-base.webhook") {
    throw new WebhookNodeNotFoundError(
      id,
      workflow.name,
      nodeName,
      `node type is "${node.type}", expected "n8n-nodes-base.webhook"`,
    );
  }
  if (node.disabled) {
    // n8n does not register a disabled node's webhook, so the URL 404s. Saying
    // so here beats letting the caller debug an opaque 404.
    throw new WebhookNodeNotFoundError(id, workflow.name, nodeName, "node is disabled");
  }

  const path = readPath(node);
  return { node, path, httpMethod: readHttpMethod(node), url: "" };
}

/** Builds the webhook URL for a path against an API/gateway base URL. */
export function buildWebhookURL(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${base}/webhook/${path.replace(/^\//, "")}`;
}

/** Lists the callable webhook nodes of a workflow, for discovery by a caller. */
export function listWebhookNodes(workflow: Workflow | null): ResolvedWebhook[] {
  if (!workflow) return [];
  return (workflow.nodes ?? [])
    .filter((n) => n.type === "n8n-nodes-base.webhook" && !n.disabled)
    .map((node) => ({ node, path: readPath(node), httpMethod: readHttpMethod(node), url: "" }));
}

function readPath(node: Node): string {
  const path = node.parameters?.path;
  return typeof path === "string" && path !== "" ? path : node.id;
}

function readHttpMethod(node: Node): string {
  const method = node.parameters?.httpMethod;
  return typeof method === "string" && method !== "" ? method.toUpperCase() : "POST";
}
