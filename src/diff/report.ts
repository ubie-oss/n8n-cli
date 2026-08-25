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
      const comparison: WorkflowComparison = {
        status: changed ? "modified" : "unchanged",
        workflowId: newWf.id ?? oldWf.id,
        name: newWf.name || oldWf.name,
        leftSource: pair.left.source,
        rightSource: pair.right.source,
        detail: changed ? detail : undefined,
      };
      // Non-enumerable so `--format json` stays compact; the HTML report's
      // raw JSON diff reads them in-process.
      Object.defineProperties(comparison, {
        leftRaw: { value: oldWf, enumerable: false },
        rightRaw: { value: newWf, enumerable: false },
      });
      comparisons.push(comparison);
    } else if (pair.right) {
      const comparison: WorkflowComparison = {
        status: "added",
        workflowId: pair.right.workflow!.id,
        name: pair.right.workflow!.name,
        rightSource: pair.right.source,
      };
      Object.defineProperty(comparison, "rightRaw", {
        value: pair.right.workflow,
        enumerable: false,
      });
      comparisons.push(comparison);
    } else {
      const comparison: WorkflowComparison = {
        status: "removed",
        workflowId: pair.left!.workflow!.id,
        name: pair.left!.workflow!.name,
        leftSource: pair.left!.source,
      };
      Object.defineProperty(comparison, "leftRaw", {
        value: pair.left!.workflow,
        enumerable: false,
      });
      comparisons.push(comparison);
    }
  }

  return {
    hasChanges: comparisons.some((c) => c.status !== "unchanged"),
    comparisons,
  };
}
