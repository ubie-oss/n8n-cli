import dagre from "@dagrejs/dagre";
import { type AiCluster, extractAiClusters, type Graph, isAiEdge } from "./graph.ts";
import {
  AI_SUBNODE_Y_OFFSET,
  AI_SUBNODE_Y_SEP,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  NODE_SEP,
  RANK_SEP,
  snapToGrid,
} from "./workflow.ts";

/** Layouts a subgraph using dagre (Sugiyama algorithm, LR direction) */
export function layoutSubgraph(graph: Graph): void {
  if (graph.nodes.size === 0) return;

  // Extract AI clusters and determine which nodes/edges to exclude from dagre
  const aiClusters = extractAiClusters(graph);
  const aiSubNodeNames = new Set<string>();
  for (const cluster of aiClusters) {
    for (const name of cluster.subNodeNames) {
      aiSubNodeNames.add(name);
    }
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    acyclicer: "greedy",
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add only main-flow nodes (exclude AI sub-nodes)
  for (const [name, _node] of graph.nodes) {
    if (!aiSubNodeNames.has(name)) {
      g.setNode(name, { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
    }
  }

  // Add only non-AI edges
  for (const edge of graph.edges) {
    if (!isAiEdge(edge)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  // Run dagre layout
  dagre.layout(g);

  // Apply positions for main-flow nodes: dagre returns center coordinates, convert to top-left
  for (const [name, node] of graph.nodes) {
    if (aiSubNodeNames.has(name)) continue;
    const dagreNode = g.node(name);
    if (dagreNode) {
      node.position.x = snapToGrid(dagreNode.x - dagreNode.width / 2);
      node.position.y = snapToGrid(dagreNode.y - dagreNode.height / 2);
    }
  }

  // Place AI sub-nodes below their parent Agent
  for (const cluster of aiClusters) {
    placeAiCluster(graph, cluster);
  }
}

/** Places AI sub-nodes vertically stacked below their parent Agent node */
function placeAiCluster(graph: Graph, cluster: AiCluster): void {
  const agentNode = graph.nodes.get(cluster.agentName);
  if (!agentNode) return;

  const subNodes = cluster.subNodeNames;
  if (subNodes.length === 0) return;

  const agentCenterX = agentNode.position.x + DEFAULT_NODE_WIDTH / 2;
  const baseY = agentNode.position.y + AI_SUBNODE_Y_OFFSET;

  for (let i = 0; i < subNodes.length; i++) {
    const subNode = graph.nodes.get(subNodes[i]!);
    if (!subNode) continue;
    subNode.position.x = snapToGrid(agentCenterX - DEFAULT_NODE_WIDTH / 2);
    subNode.position.y = snapToGrid(baseY + i * AI_SUBNODE_Y_SEP);
  }
}
