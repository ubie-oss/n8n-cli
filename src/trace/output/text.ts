import { formatTable } from "@/cli/output/table.ts";
import type { TraceResult } from "../types.ts";

/** Format trace result as text table */
export function formatTraceText(result: TraceResult): void {
  console.log(`Workflow: ${result.workflowName} (${result.file})`);
  console.log();

  const headers = ["NODE", "CARDINALITY", "ITEMS", "HINTS"];
  const rows = result.nodes.map((node) => [
    node.nodeName,
    node.cardinality,
    node.estimatedItems,
    node.hints.join("; "),
  ]);

  formatTable(headers, rows);

  if (result.cycles.length > 0) {
    console.log();
    console.log("Cycles:");
    for (const cycle of result.cycles) {
      console.log(`  ${cycle.join(" → ")}`);
    }
  }

  if (result.hints.length > 0) {
    console.log();
    console.log("Hints:");
    for (const hint of result.hints) {
      console.log(`  ${hint}`);
    }
  }
}
