import type { Node, Workflow } from "../api/types.ts";

/** TestWebhookNodePrefix is the required prefix for test webhook node names */
export const TestWebhookNodePrefix = "[CLI Test]";

/** WebhookInfo contains extracted webhook information */
export interface WebhookInfo {
  node: Node;
  path: string;
  httpMethod: string;
  fullURL: string;
}

/** WorkflowInput represents an input parameter for a workflow */
export interface WorkflowInput {
  name: string;
  type: string;
  required: boolean;
}

/** NoTestWebhookError is returned when no test webhook is found in a workflow */
export class NoTestWebhookError extends Error {
  readonly workflowId: string;
  readonly workflowName: string;

  constructor(workflowId: string, workflowName: string) {
    super(`no test webhook found in workflow "${workflowName}" (${workflowId})`);
    this.name = "NoTestWebhookError";
    this.workflowId = workflowId;
    this.workflowName = workflowName;
  }

  hint(): string {
    return `To enable CLI testing, add a webhook node with:
  - Type: n8n-nodes-base.webhook
  - Name: must start with "[CLI Test]" (e.g., "[CLI Test] Test Entry")
  - Path: UUID v4 format (e.g., "5bf62c14-fca6-4ec0-92f7-6d07bd1c39b7")
  - webhookId: MUST be set to the same value as path (required for API-based registration)

Example node (JSON):
{
  id: "<UUID v4 for node>",
  name: "[CLI Test] Test Entry",
  type: "n8n-nodes-base.webhook",
  typeVersion: 2.1,
  position: [-200, 0],
  parameters: {
    httpMethod: "POST",
    path: "<UUID v4 for webhook>",
    options: {}
  },
  webhookId: "<UUID v4 for webhook>",  // Same as path - REQUIRED!
}

Generate UUIDs with: uuidgen | tr '[:upper:]' '[:lower:]'`;
  }
}

/**
 * DetectTestWebhook finds a test webhook node in the workflow.
 * A test webhook is identified by:
 * - Type: n8n-nodes-base.webhook
 * - Node name starting with "[CLI Test]"
 */
export function detectTestWebhook(workflow: Workflow | null): WebhookInfo {
  if (!workflow) {
    throw new Error("workflow is nil");
  }

  for (const node of workflow.nodes) {
    if (node.type !== "n8n-nodes-base.webhook") continue;
    if (!node.name.startsWith(TestWebhookNodePrefix)) continue;

    // Get path parameter
    let path = (node.parameters?.path as string) || "";
    if (!path) {
      path = node.id;
    }

    // Extract HTTP method (default to POST)
    const httpMethod = (node.parameters?.httpMethod as string) || "POST";

    return {
      node,
      path,
      httpMethod,
      fullURL: "",
    };
  }

  throw new NoTestWebhookError(workflow.id ?? "", workflow.name);
}

/** IsTestWebhook checks if a node is a test webhook */
export function isTestWebhook(node: Node | null): boolean {
  if (!node || node.type !== "n8n-nodes-base.webhook") return false;
  return node.name.startsWith(TestWebhookNodePrefix);
}

/** ExtractWorkflowInputs extracts input parameters from an executeWorkflowTrigger node */
export function extractWorkflowInputs(workflow: Workflow | null): WorkflowInput[] {
  if (!workflow) return [];

  for (const node of workflow.nodes) {
    if (node.type !== "n8n-nodes-base.executeWorkflowTrigger") continue;

    const params = node.parameters;
    if (!params) continue;

    const workflowInputs = params.workflowInputs as Record<string, unknown> | undefined;
    if (!workflowInputs) continue;

    const values = workflowInputs.values as unknown[] | undefined;
    if (!Array.isArray(values)) continue;

    const inputs: WorkflowInput[] = [];
    for (const v of values) {
      const valMap = v as Record<string, unknown>;
      if (typeof valMap !== "object" || valMap === null) continue;

      const name = valMap.name as string;
      if (!name) continue;

      inputs.push({
        name,
        type: (valMap.type as string) || "string",
        required: true,
      });
    }

    return inputs;
  }

  return [];
}

/** BuildWebhookURL builds the full webhook URL from base URL and path */
export function buildWebhookURL(baseURL: string, path: string): string {
  let url = baseURL.replace(/\/+$/, "");
  url = url.replace(/\/api\/v1$/, "");
  path = path.replace(/^\//, "");
  return `${url}/webhook/${path}`;
}
