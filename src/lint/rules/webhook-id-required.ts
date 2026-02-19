import type { Workflow } from "@/api/types.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/**
 * Validates that webhook and formTrigger nodes have webhookId field.
 *
 * Background:
 * - Webhook nodes without webhookId result in HTTP 404 errors
 * - FormTrigger nodes without webhookId result in "Problem loading form" errors
 * - webhookId is required for n8n to register the webhook/form properly
 */
export const webhookIdRequiredRule: Rule = {
  name: "webhook-id-required",
  description: "Check that webhook and formTrigger nodes have webhookId field",
  defaultSeverity: "error",
  check(workflow: Workflow | null, _rawJSON: string): Violation[] {
    if (!workflow) return [];

    const violations: Violation[] = [];
    const webhookNodeTypes = ["n8n-nodes-base.webhook", "n8n-nodes-base.formTrigger"];

    for (const node of workflow.nodes) {
      if (!webhookNodeTypes.includes(node.type)) continue;

      if (!node.webhookId) {
        violations.push({
          rule: "webhook-id-required",
          severity: "error",
          message: `Node "${node.name}" (${node.type}): missing required field "webhookId"`,
        });
      }
    }

    return violations;
  },
};
