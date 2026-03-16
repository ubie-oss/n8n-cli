import type { Workflow } from "@/api/types.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

interface BannedNodeEntry {
  type: string;
  reason?: string;
}

/**
 * Detects usage of banned node types specified in the rule options.
 *
 * Options:
 *   nodes: Array of { type: string; reason?: string }
 */
export const bannedNodeRule: Rule = {
  name: "banned-node",
  description: "Detect usage of banned node types",
  defaultSeverity: "warning",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const entries = (options?.nodes as BannedNodeEntry[] | undefined) ?? [];
    if (entries.length === 0) return [];

    const bannedMap = new Map<string, string | undefined>();
    for (const entry of entries) {
      bannedMap.set(entry.type, entry.reason);
    }

    const violations: Violation[] = [];

    for (const node of workflow.nodes) {
      if (bannedMap.has(node.type)) {
        const reason = bannedMap.get(node.type);
        const message = reason
          ? `Node "${node.name}" uses banned type "${node.type}": ${reason}`
          : `Node "${node.name}" uses banned type "${node.type}"`;
        violations.push({
          rule: "banned-node",
          severity: "warning",
          message,
        });
      }
    }

    return violations;
  },
};
