import { type FormatterNode, type FormatterWorkflow, isStickyNote } from "./workflow.ts";

/** Position represents a 2D coordinate */
export interface Position {
  x: number;
  y: number;
}

/** Edge represents a directed edge between two nodes */
export interface Edge {
  from: string;
  to: string;
  type: string; // "main" | "ai_languageModel" | "ai_tool" | "ai_memory" | "ai_outputParser" | ...
}

/** Returns true if the edge is an AI connection (ai_languageModel, ai_tool, etc.) */
export function isAiEdge(edge: Edge): boolean {
  return edge.type.startsWith("ai_");
}

/** AiCluster groups an Agent node with its AI sub-nodes */
export interface AiCluster {
  agentName: string;
  subNodeNames: string[];
}

/** GraphNode represents a node in the graph with layout information */
export interface GraphNode {
  name: string;
  original: FormatterNode;
  position: Position;
}

/** Graph represents a workflow as a directed graph */
export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Edge[];
}

/** NewGraph creates a new empty graph */
export function newGraph(): Graph {
  return {
    nodes: new Map(),
    edges: [],
  };
}

/** BuildFullGraph constructs a graph from a workflow, including all connection types (main + ai_*) */
export function buildFullGraph(workflow: FormatterWorkflow): Graph {
  const graph = newGraph();

  // Extract edges from all connection types
  for (const [sourceName, connData] of Object.entries(workflow.connections)) {
    const sourceNode = findNodeByName(workflow, sourceName);
    if (!sourceNode || isStickyNote(sourceNode)) {
      continue;
    }

    const connMap = connData as Record<string, unknown>;
    if (typeof connMap !== "object" || connMap === null) {
      continue;
    }

    // Process all connection types (main, ai_languageModel, ai_outputParser, ai_tool, ai_memory, etc.)
    for (const [connType, conns] of Object.entries(connMap)) {
      if (!conns || !Array.isArray(conns)) {
        continue;
      }

      for (const connGroup of conns) {
        if (!Array.isArray(connGroup)) {
          continue;
        }

        for (const conn of connGroup) {
          const connObj = conn as Record<string, unknown>;
          if (typeof connObj !== "object" || connObj === null) {
            continue;
          }

          const targetName = connObj.node;
          if (typeof targetName !== "string") {
            continue;
          }

          const targetNode = findNodeByName(workflow, targetName);
          if (!targetNode || isStickyNote(targetNode)) {
            continue;
          }

          graph.edges.push({ from: sourceName, to: targetName, type: connType });
        }
      }
    }
  }

  // Add all nodes to graph (excluding sticky notes)
  for (const node of workflow.nodes) {
    if (isStickyNote(node)) {
      continue;
    }

    graph.nodes.set(node.name, {
      name: node.name,
      original: node,
      position: { x: 0, y: 0 },
    });
  }

  return graph;
}

/** extractAiClusters identifies AI sub-nodes and groups them by their parent Agent node */
export function extractAiClusters(graph: Graph): AiCluster[] {
  const mainEdges = graph.edges.filter((e) => !isAiEdge(e));
  const aiEdges = graph.edges.filter(isAiEdge);

  if (aiEdges.length === 0) return [];

  // Nodes that participate in main edges (as source or target)
  const mainNodeNames = new Set<string>();
  for (const edge of mainEdges) {
    mainNodeNames.add(edge.from);
    mainNodeNames.add(edge.to);
  }

  // AI sub-nodes: nodes that are sources of AI edges and do NOT participate in main edges.
  // A node that is only a TARGET of AI edges (never a source) is an Agent, not a sub-node.
  const aiSources = new Set(aiEdges.map((e) => e.from));
  const aiSubNodeNames = new Set<string>();
  for (const name of graph.nodes.keys()) {
    if (!mainNodeNames.has(name) && aiSources.has(name)) {
      aiSubNodeNames.add(name);
    }
  }

  if (aiSubNodeNames.size === 0) return [];

  // Non-sub-nodes (agents or main-flow nodes): everything except AI sub-nodes
  const nonSubNodeNames = new Set<string>();
  for (const name of graph.nodes.keys()) {
    if (!aiSubNodeNames.has(name)) {
      nonSubNodeNames.add(name);
    }
  }

  // For each AI sub-node, find its Agent by following ai_* edges
  const agentMap = new Map<string, Set<string>>(); // agentName -> Set of subNodeNames

  for (const subNode of aiSubNodeNames) {
    const agent = findAgent(subNode, aiEdges, nonSubNodeNames);
    if (agent) {
      if (!agentMap.has(agent)) {
        agentMap.set(agent, new Set());
      }
      agentMap.get(agent)!.add(subNode);
    }
  }

  return [...agentMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agentName, subNodes]) => ({
      agentName,
      subNodeNames: [...subNodes].sort(),
    }));
}

/** Recursively follows ai_* edges from a sub-node to find the Agent (a non-sub-node) */
function findAgent(
  nodeName: string,
  aiEdges: Edge[],
  nonSubNodeNames: Set<string>,
  visited: Set<string> = new Set(),
): string | undefined {
  if (visited.has(nodeName)) return undefined;
  visited.add(nodeName);

  for (const edge of aiEdges) {
    if (edge.from === nodeName) {
      if (nonSubNodeNames.has(edge.to)) {
        return edge.to;
      }
      // Chain case: follow through intermediate ai sub-nodes
      const agent = findAgent(edge.to, aiEdges, nonSubNodeNames, visited);
      if (agent) return agent;
    }
  }
  return undefined;
}

/** findNodeByName finds a node by name in a workflow */
function findNodeByName(workflow: FormatterWorkflow, name: string): FormatterNode | undefined {
  return workflow.nodes.find((n) => n.name === name);
}
