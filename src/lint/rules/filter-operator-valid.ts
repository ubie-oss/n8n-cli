import type { Workflow } from "@/api/types.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/**
 * Valid operations per operator type, manually derived from n8n-workflow's executeFilterCondition().
 *
 * Maintenance note:
 * - This mapping is intentionally kept in sync with n8n-workflow's filter logic.
 * - When updating the n8n-workflow dependency (see package.json), re-check executeFilterCondition()
 *   and update this table accordingly to avoid false positives for newly added operations.
 * - Last synced against n8n-workflow version: 1.120.9
 *
 * `exists` and `notExists` are handled before the type switch, so they apply to all types.
 */
const COMMON_OPS = ["exists", "notExists"] as const;

const VALID_OPERATIONS: Record<string, Set<string>> = {
  string: new Set([
    ...COMMON_OPS,
    "empty",
    "notEmpty",
    "equals",
    "notEquals",
    "contains",
    "notContains",
    "startsWith",
    "notStartsWith",
    "endsWith",
    "notEndsWith",
    "regex",
    "notRegex",
  ]),
  number: new Set([
    ...COMMON_OPS,
    "empty",
    "notEmpty",
    "equals",
    "notEquals",
    "gt",
    "lt",
    "gte",
    "lte",
  ]),
  dateTime: new Set([
    ...COMMON_OPS,
    "empty",
    "notEmpty",
    "equals",
    "notEquals",
    "after",
    "before",
    "afterOrEquals",
    "beforeOrEquals",
  ]),
  boolean: new Set([...COMMON_OPS, "empty", "notEmpty", "true", "false", "equals", "notEquals"]),
  array: new Set([
    ...COMMON_OPS,
    "contains",
    "notContains",
    "lengthEquals",
    "lengthNotEquals",
    "lengthGt",
    "lengthLt",
    "lengthGte",
    "lengthLte",
    "empty",
    "notEmpty",
  ]),
  object: new Set([...COMMON_OPS, "empty", "notEmpty"]),
};

const TARGET_TYPES = new Set(["n8n-nodes-base.if", "n8n-nodes-base.filter"]);

export const filterOperatorValidRule: Rule = {
  name: "filter-operator-valid",
  description: "Check that filter/if condition operators use valid operations",
  defaultSeverity: "error",
  check(workflow: Workflow | null, _rawJSON: string): Violation[] {
    if (!workflow) return [];

    const violations: Violation[] = [];

    for (const node of workflow.nodes) {
      if (!TARGET_TYPES.has(node.type)) continue;
      if (node.typeVersion < 2) continue;

      const params = node.parameters as Record<string, unknown> | undefined;
      if (!params) continue;

      const conditions = params.conditions as Record<string, unknown> | undefined;
      if (!conditions) continue;

      const conditionList = conditions.conditions as unknown[] | undefined;
      if (!Array.isArray(conditionList)) continue;

      for (const cond of conditionList) {
        if (!cond || typeof cond !== "object") continue;

        const operator = (cond as Record<string, unknown>).operator as
          | Record<string, unknown>
          | undefined;
        if (!operator) continue;

        const type = operator.type as string | undefined;
        const operation = operator.operation as string | undefined;
        if (!type || !operation) continue;

        const validOps = VALID_OPERATIONS[type];
        // Skip unknown types to avoid false positives when n8n adds new types
        if (!validOps) continue;

        if (!validOps.has(operation)) {
          violations.push({
            rule: "filter-operator-valid",
            severity: "error",
            message: `Node "${node.name}" (${node.type}): invalid operation "${operation}" for type "${type}"`,
          });
        }
      }
    }

    return violations;
  },
};
