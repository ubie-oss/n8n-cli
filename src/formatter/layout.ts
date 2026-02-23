import dagre from "@dagrejs/dagre";
import type { Graph } from "./graph.ts";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  NODE_SEP,
  RANK_SEP,
  snapToGrid,
} from "./workflow.ts";

/** Layouts a subgraph using dagre (Sugiyama algorithm, LR direction) */
export function layoutSubgraph(graph: Graph): void {
  if (graph.nodes.size === 0) return;

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    acyclicer: "greedy",
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add nodes
  for (const [name, _node] of graph.nodes) {
    g.setNode(name, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
  }

  // Add edges
  for (const edge of graph.edges) {
    g.setEdge(edge.from, edge.to);
  }

  // Run dagre layout
  dagre.layout(g);

  // Apply positions: dagre returns center coordinates, convert to top-left
  for (const [name, node] of graph.nodes) {
    const dagreNode = g.node(name);
    if (dagreNode) {
      node.position.x = snapToGrid(dagreNode.x - dagreNode.width / 2);
      node.position.y = snapToGrid(dagreNode.y - dagreNode.height / 2);
    }
  }
}
