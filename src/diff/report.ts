import type { Workflow } from "../api/types.ts";
import { compareWorkflows, isDetailEmpty } from "./engine.ts";
import type { DiffOptions, DiffReport, WorkflowComparison } from "./model.ts";
import { pairWorkflows } from "./sources.ts";

/**
 * Builds a report from two already-loaded workflow sets. The left side is the
 * "old" state (base ref, remote server, first file), the right side the "new"
 * state (working tree, local definitions, second file).
 */
export function buildReport(
  left: Array<{ workflow: Workflow; source?: string }>,
  right: Array<{ workflow: Workflow; source?: string }>,
  opts: DiffOptions = {},
): DiffReport {
  const comparisons: WorkflowComparison[] = [];

  for (const pair of pairWorkflows(left, right)) {
    if (pair.left && pair.right) {
      const oldWf = pair.left.workflow!;
      const newWf = pair.right.workflow!;
      const detail = compareWorkflows(oldWf, newWf, opts);
      const changed = !isDetailEmpty(detail);
      comparisons.push({
        status: changed ? "modified" : "unchanged",
        workflowId: newWf.id ?? oldWf.id,
        name: newWf.name || oldWf.name,
        leftSource: pair.left.source,
        rightSource: pair.right.source,
        detail: changed ? detail : undefined,
      });
    } else if (pair.right) {
      comparisons.push({
        status: "added",
        workflowId: pair.right.workflow!.id,
        name: pair.right.workflow!.name,
        rightSource: pair.right.source,
      });
    } else {
      comparisons.push({
        status: "removed",
        workflowId: pair.left!.workflow!.id,
        name: pair.left!.workflow!.name,
        leftSource: pair.left!.source,
      });
    }
  }

  return {
    hasChanges: comparisons.some((c) => c.status !== "unchanged"),
    comparisons,
  };
}
