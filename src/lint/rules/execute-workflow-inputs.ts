import type { Workflow } from "@/api/types.ts";
import type { LintContext, Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

const EXECUTE_WORKFLOW = "n8n-nodes-base.executeWorkflow";
const EXECUTE_WORKFLOW_TRIGGER = "n8n-nodes-base.executeWorkflowTrigger";

/** Reports caller inputs that are not declared by the called workflow. */
export const executeWorkflowInputsExtraRule: Rule = {
  name: "execute-workflow-inputs-extra",
  description: "Check executeWorkflow inputs are declared by the called workflow",
  defaultSeverity: "error",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    _options?,
    context?: LintContext,
  ): Violation[] {
    return checkWorkflowInputs(workflow, context).extra;
  },
};

/** Reports called-workflow inputs that the caller does not provide. */
export const executeWorkflowInputsMissingRule: Rule = {
  name: "execute-workflow-inputs-missing",
  description: "Check executeWorkflow provides every input declared by the called workflow",
  defaultSeverity: "warning",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    _options?,
    context?: LintContext,
  ): Violation[] {
    return checkWorkflowInputs(workflow, context).missing;
  },
};

function checkWorkflowInputs(
  workflow: Workflow | null,
  context: LintContext | undefined,
): { extra: Violation[]; missing: Violation[] } {
  const extra: Violation[] = [];
  const missing: Violation[] = [];
  if (!workflow || !context?.workflows) return { extra, missing };

  const workflowsById =
    context.workflowsById ??
    new Map(
      context.workflows
        .filter((candidate) => typeof candidate.id === "string" && candidate.id.length > 0)
        .map((candidate) => [candidate.id!, candidate]),
    );

  for (const node of workflow.nodes) {
    if (node.type !== EXECUTE_WORKFLOW) continue;
    const parameters = node.parameters ?? {};
    const workflowId = getStaticValue(parameters.workflowId);
    if (typeof workflowId !== "string" || isDynamic(workflowId)) continue;

    const callee = workflowsById.get(workflowId);
    if (!callee) continue;

    const declaredInputs = getDeclaredInputs(callee);
    if (!declaredInputs) continue;

    const callerInputs = getObjectKeys(parameters.workflowInputs);
    if (!callerInputs) continue;

    for (const key of callerInputs) {
      if (!declaredInputs.has(key)) {
        extra.push({
          rule: "execute-workflow-inputs-extra",
          severity: "error",
          message: `Node "${node.name}" passes undeclared workflow input "${key}" to "${callee.name}"`,
        });
      }
    }

    for (const key of declaredInputs) {
      if (!callerInputs.has(key)) {
        missing.push({
          rule: "execute-workflow-inputs-missing",
          severity: "warning",
          message: `Node "${node.name}" does not provide workflow input "${key}" declared by "${callee.name}"`,
        });
      }
    }
  }

  return { extra, missing };
}

function getStaticValue(value: unknown): unknown {
  if (isRecord(value) && "value" in value) return value.value;
  return value;
}

function getObjectKeys(value: unknown): Set<string> | null {
  const input = getStaticValue(value);
  if (!isRecord(input)) return null;
  return new Set(Object.keys(input));
}

/** Returns null when the called workflow has no explicit input declaration. */
function getDeclaredInputs(workflow: Workflow): Set<string> | null {
  for (const node of workflow.nodes) {
    if (node.type !== EXECUTE_WORKFLOW_TRIGGER) continue;
    const workflowInputs = node.parameters?.workflowInputs;
    if (!isRecord(workflowInputs) || workflowInputs.acceptAll === true) return null;
    if (!Array.isArray(workflowInputs.values)) return null;

    const names = new Set<string>();
    for (const value of workflowInputs.values) {
      if (isRecord(value) && typeof value.name === "string" && value.name.length > 0) {
        names.add(value.name);
      }
    }
    return names;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDynamic(value: string): boolean {
  return value.startsWith("=") || value.includes("{{") || value.includes("$");
}
