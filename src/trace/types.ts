import type { OutputCardinality } from "@/lint/rules/node-schema.ts";

/** NodeTrace represents the trace result for a single node */
export interface NodeTrace {
  nodeName: string;
  nodeType: string;
  cardinality: OutputCardinality | "unknown";
  estimatedItems: string;
  inputs: string[];
  outputs: string[];
  hints: string[];
}

/** TraceResult represents the full trace analysis for a workflow */
export interface TraceResult {
  workflowName: string;
  file: string;
  nodes: NodeTrace[];
  cycles: string[][];
  hints: string[];
}
