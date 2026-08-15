import type { Node, Workflow } from "@/api/types.ts";
import { getOutputSchema, parseNodeRefs } from "./node-schema.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

const externalNodeTypes = new Set([
  "n8n-nodes-base.googleBigQuery",
  "n8n-nodes-base.httpRequest",
  "n8n-nodes-base.notion",
  "n8n-nodes-base.slack",
]);

/** Warn when a data-dependent external call will repeat for a multi-item input. */
export const externalNodeRepeatedCallRule: Rule = {
  name: "external-node-repeated-call",
  description: "Check for external calls repeated for each upstream item",
  defaultSeverity: "warning",
  check(workflow: Workflow | null): Violation[] {
    return findRepeatedCalls(workflow, true, "external-node-repeated-call", "warning");
  },
};

/** Error when an identical external call will repeat for a multi-item input. */
export const externalNodeStaticRepeatedCallRule: Rule = {
  name: "external-node-static-repeated-call",
  description: "Check for identical external calls repeated for each upstream item",
  defaultSeverity: "error",
  check(workflow: Workflow | null): Violation[] {
    return findRepeatedCalls(workflow, false, "external-node-static-repeated-call", "error");
  },
};

function findRepeatedCalls(
  workflow: Workflow | null,
  expectedInputDependency: boolean,
  rule: string,
  severity: "error" | "warning",
): Violation[] {
  if (!workflow) return [];

  const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
  const predecessors = buildPredecessors(workflow);
  const violations: Violation[] = [];

  for (const node of workflow.nodes) {
    if (!externalNodeTypes.has(node.type) || node.disabled || node.executeOnce === true) continue;
    if (!receivesMultipleItems(node.name, predecessors, nodes, new Set())) continue;

    const ancestors = collectAncestors(node.name, predecessors);
    const inputDependent = hasInputDependentParameter(node.parameters, ancestors);
    if (inputDependent !== expectedInputDependency) continue;

    violations.push({
      rule,
      severity,
      message: inputDependent
        ? `External node "${node.name}" (${node.type}) can run once per upstream item. Enable executeOnce when only one call is intended`
        : `External node "${node.name}" (${node.type}) can repeat the same input-independent call for every upstream item. Enable executeOnce or reference upstream data`,
    });
  }

  return violations;
}

function buildPredecessors(workflow: Workflow): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [source, connection] of Object.entries(workflow.connections)) {
    for (const output of connection.main ?? []) {
      for (const target of output ?? []) {
        const existing = result.get(target.node) ?? [];
        existing.push(source);
        result.set(target.node, existing);
      }
    }
  }
  return result;
}

function receivesMultipleItems(
  nodeName: string,
  predecessors: Map<string, string[]>,
  nodes: Map<string, Node>,
  visiting: Set<string>,
): boolean {
  if (visiting.has(nodeName)) return false;
  visiting.add(nodeName);

  const sources = predecessors.get(nodeName) ?? [];
  if (sources.length > 1) return true;

  for (const sourceName of sources) {
    const source = nodes.get(sourceName);
    if (!source || source.disabled) continue;
    const schema = getOutputSchema(source.type);
    const params = (source.parameters as Record<string, unknown>) ?? {};
    const cardinality = schema?.parameterDerivedCardinality?.(params) ?? schema?.cardinality;
    if (cardinality === "1:N") return true;
    if (cardinality === "pass-through") {
      if (receivesMultipleItems(sourceName, predecessors, nodes, new Set(visiting))) return true;
    }
  }

  return false;
}

function collectAncestors(nodeName: string, predecessors: Map<string, string[]>): Set<string> {
  const ancestors = new Set<string>();
  const queue = [...(predecessors.get(nodeName) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    queue.push(...(predecessors.get(current) ?? []));
  }
  return ancestors;
}

function hasInputDependentParameter(value: unknown, ancestors: Set<string>): boolean {
  if (typeof value === "string") {
    if (/\$(?:json|input|item)\b/.test(value)) return true;
    return parseNodeRefs(value).some((ref) => ancestors.has(ref.nodeName));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasInputDependentParameter(entry, ancestors));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      hasInputDependentParameter(entry, ancestors),
    );
  }
  return false;
}
