import type { Connection, Node, Workflow } from "@/api/types.ts";
import { buildAdjacencyList } from "@/lint/rules/node-ref-cardinality.ts";
import type { OutputCardinality } from "@/lint/rules/node-schema.ts";
import { getOutputSchema } from "@/lint/rules/node-schema.ts";
import type { NodeTrace, TraceResult } from "./types.ts";

/** Build reverse adjacency list (target → sources) */
function buildReverseAdjacencyList(workflow: Workflow): Map<string, string[]> {
  const rev = new Map<string, string[]>();

  for (const [sourceName, conn] of Object.entries(workflow.connections)) {
    if (conn.main) {
      for (const targets of conn.main) {
        if (!Array.isArray(targets)) continue;
        for (const target of targets as Connection[]) {
          const existing = rev.get(target.node) ?? [];
          existing.push(sourceName);
          rev.set(target.node, existing);
        }
      }
    }
  }

  return rev;
}

/** Compute in-degree for each node */
function computeInDegree(
  nodeNames: string[],
  reverseAdj: Map<string, string[]>,
): Map<string, number> {
  const inDeg = new Map<string, number>();
  for (const name of nodeNames) {
    inDeg.set(name, (reverseAdj.get(name) ?? []).length);
  }
  return inDeg;
}

/** Topological sort using Kahn's algorithm. Returns sorted nodes and cycle members. */
function topologicalSort(
  nodeNames: string[],
  adj: Map<string, string[]>,
  reverseAdj: Map<string, string[]>,
): { sorted: string[]; cycleNodes: string[] } {
  const inDeg = computeInDegree(nodeNames, reverseAdj);
  const queue: string[] = [];

  for (const name of nodeNames) {
    if ((inDeg.get(name) ?? 0) === 0) {
      queue.push(name);
    }
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      const deg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, deg);
      if (deg === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Nodes not in sorted list are part of cycles
  const sortedSet = new Set(sorted);
  const cycleNodes = nodeNames.filter((n) => !sortedSet.has(n));

  return { sorted, cycleNodes };
}

/** Propagate estimated items based on cardinality */
function propagateItems(inputItems: string[], cardinality: OutputCardinality | "unknown"): string {
  if (inputItems.length === 0) return "1";

  // Use first input for propagation (multi-input handled separately for merge)
  const input = inputItems[0]!;

  switch (cardinality) {
    case "1:1":
      return input;
    case "1:N":
      return input === "1" ? "N" : `${input}*M`;
    case "N:1":
      return "1";
    case "pass-through":
      return input;
    case "variable":
      return "?";
    case "unknown":
      return "?";
  }
}

/** Resolve cardinality for a node, considering parameter-derived overrides */
function resolveCardinality(node: Node): OutputCardinality | "unknown" {
  const schema = getOutputSchema(node.type);
  if (!schema) return "unknown";
  if (schema.parameterDerivedCardinality) {
    const params = (node.parameters as Record<string, unknown>) ?? {};
    return schema.parameterDerivedCardinality(params);
  }
  return schema.cardinality;
}

/** Analyze a workflow and produce trace results */
export function analyzeWorkflow(workflow: Workflow, file: string): TraceResult {
  const adj = buildAdjacencyList(workflow);
  const reverseAdj = buildReverseAdjacencyList(workflow);

  // Build node type map and node map
  const nodeTypeMap = new Map<string, string>();
  const nodeMap = new Map<string, Node>();
  const nodeSet = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.type === "n8n-nodes-base.stickyNote") continue;
    nodeTypeMap.set(node.name, node.type);
    nodeMap.set(node.name, node);
    nodeSet.add(node.name);
  }

  const nodeNames = [...nodeSet];
  const { sorted, cycleNodes } = topologicalSort(nodeNames, adj, reverseAdj);

  // Track estimated items per node
  const estimatedItems = new Map<string, string>();
  const nodeHints = new Map<string, string[]>();

  // Mark cycle nodes
  const cycleSet = new Set(cycleNodes);
  for (const name of cycleNodes) {
    estimatedItems.set(name, "loop");
    nodeHints.set(name, []);
  }

  // Process nodes in topological order
  for (const name of sorted) {
    const nodeType = nodeTypeMap.get(name) ?? "";
    const node = nodeMap.get(name);
    const cardinality: OutputCardinality | "unknown" = node ? resolveCardinality(node) : "unknown";

    const inputs = reverseAdj.get(name) ?? [];
    const inputEstimates = inputs
      .map((inp) => estimatedItems.get(inp))
      .filter((v): v is string => v !== undefined);

    const hints: string[] = [];

    // Special case: merge node with append mode
    if (nodeType === "n8n-nodes-base.merge") {
      const node = workflow.nodes.find((n) => n.name === name);
      const params = (node?.parameters as Record<string, unknown>) ?? {};
      if (params.mode === "append") {
        const inputLabels = inputs.map((inp) => estimatedItems.get(inp) ?? "?");
        hints.push(`items = ${inputLabels.join(" + ")}`);
      }
    }

    // Propagate items
    let items: string;
    if (inputEstimates.some((e) => e === "loop")) {
      items = "loop";
    } else {
      items = propagateItems(inputEstimates, cardinality);
    }

    estimatedItems.set(name, items);
    nodeHints.set(name, hints);
  }

  // Build output adjacency for each node
  const nodeOutputs = new Map<string, string[]>();
  for (const [source, targets] of adj) {
    nodeOutputs.set(source, targets);
  }

  // Build trace nodes in topological order, with cycle nodes appended
  const allNodes = [...sorted, ...cycleNodes];
  const traceNodes: NodeTrace[] = [];

  for (const name of allNodes) {
    const nodeType = nodeTypeMap.get(name) ?? "";
    const traceNode = nodeMap.get(name);
    const cardinality: OutputCardinality | "unknown" = traceNode
      ? resolveCardinality(traceNode)
      : "unknown";

    traceNodes.push({
      nodeName: name,
      nodeType,
      cardinality,
      estimatedItems: estimatedItems.get(name) ?? "?",
      inputs: reverseAdj.get(name) ?? [],
      outputs: nodeOutputs.get(name) ?? [],
      hints: nodeHints.get(name) ?? [],
    });
  }

  // Collect global hints
  const globalHints: string[] = [];
  for (const node of traceNodes) {
    for (const hint of node.hints) {
      globalHints.push(`${node.nodeName}: ${hint}`);
    }
  }

  // Detect cycles as groups
  const cycles: string[][] = cycleNodes.length > 0 ? [cycleNodes] : [];

  return {
    workflowName: workflow.name,
    file,
    nodes: traceNodes,
    cycles,
    hints: globalHints,
  };
}
