import { type Graph, newGraph } from "./graph.ts";
import { SUBGRAPH_GAP } from "./workflow.ts";

/** Decomposes a graph into disconnected subgraphs using Union-Find */
export function decomposeSubgraphs(graph: Graph): Graph[] {
  const nodeNames = [...graph.nodes.keys()];
  if (nodeNames.length === 0) return [];

  // Union-Find
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  for (const name of nodeNames) {
    parent.set(name, name);
    rank.set(name, 0);
  }

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) ?? 0;
    const rankB = rank.get(rb) ?? 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else if (rankA > rankB) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, rankA + 1);
    }
  }

  // Union connected nodes
  for (const edge of graph.edges) {
    if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
      union(edge.from, edge.to);
    }
  }

  // Group nodes by component
  const components = new Map<string, string[]>();
  for (const name of nodeNames) {
    const root = find(name);
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root)!.push(name);
  }

  // Sort components by their smallest node name for determinism
  const sortedComponents = [...components.values()].sort((a, b) => {
    const minA = [...a].sort()[0]!;
    const minB = [...b].sort()[0]!;
    return minA.localeCompare(minB);
  });

  // Build subgraphs
  return sortedComponents.map((nodeNames) => {
    const subgraph = newGraph();
    const nodeSet = new Set(nodeNames);

    for (const name of nodeNames) {
      const node = graph.nodes.get(name);
      if (node) {
        subgraph.nodes.set(name, { ...node, position: { ...node.position } });
      }
    }

    for (const edge of graph.edges) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        subgraph.edges.push(edge);
      }
    }

    return subgraph;
  });
}

/** Composes laid-out subgraphs by stacking them vertically with SUBGRAPH_GAP spacing */
export function composeSubgraphs(subgraphs: Graph[]): Graph {
  const composed = newGraph();
  let currentY = 0;

  for (const subgraph of subgraphs) {
    // Find the bounding box of this subgraph
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const node of subgraph.nodes.values()) {
      minY = Math.min(minY, node.position.y);
      maxY = Math.max(maxY, node.position.y);
    }

    if (!Number.isFinite(minY)) continue;

    const offsetY = currentY - minY;

    for (const [name, node] of subgraph.nodes) {
      composed.nodes.set(name, {
        ...node,
        position: { x: node.position.x, y: node.position.y + offsetY },
      });
    }

    for (const edge of subgraph.edges) {
      composed.edges.push(edge);
    }

    currentY = maxY + offsetY + SUBGRAPH_GAP;
  }

  return composed;
}
