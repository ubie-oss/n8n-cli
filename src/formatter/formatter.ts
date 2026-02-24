import type { Graph } from "./graph.ts";
import { buildFullGraph } from "./graph.ts";
import { layoutSubgraph } from "./layout.ts";
import { composeSubgraphs, decomposeSubgraphs } from "./subgraph.ts";
import {
  DEFAULT_NODE_HEIGHT,
  ErrEmptyWorkflow,
  type FormatterNode,
  type FormatterWorkflow,
  isStickyNote,
  loadWorkflow,
  loadWorkflowAsync,
  saveWorkflow,
  snapToGrid,
} from "./workflow.ts";

/** PositionChange represents a change in node position */
export interface PositionChange {
  nodeName: string;
  oldPos: [number, number];
  newPos: [number, number];
}

/** ProcessResult represents the result of processing a single file */
export interface ProcessResult {
  filePath: string;
  success: boolean;
  error?: Error;
  changes: PositionChange[];
}

/** FormatOptions represents options for formatting workflows */
export interface FormatOptions {
  dryRun: boolean;
}

/** Default sticky note dimensions (matching n8n defaults) */
const DEFAULT_STICKY_WIDTH = 150;
const DEFAULT_STICKY_HEIGHT = 150;
const STICKY_PADDING = 40;

/** ApplyPositions updates node positions in the workflow from the graph */
export function applyPositions(workflow: FormatterWorkflow, graph: Graph): PositionChange[] {
  const changes: PositionChange[] = [];

  for (const node of workflow.nodes) {
    if (isStickyNote(node)) continue;

    const graphNode = graph.nodes.get(node.name);
    if (!graphNode) continue;

    const newX = snapToGrid(graphNode.position.x);
    const newY = snapToGrid(graphNode.position.y);

    const oldPos: [number, number] = [node.position[0], node.position[1]];
    const newPos: [number, number] = [newX, newY];

    if (oldPos[0] !== newPos[0] || oldPos[1] !== newPos[1]) {
      changes.push({ nodeName: node.name, oldPos, newPos });
    }

    node.position = newPos;
  }

  return changes;
}

/** RelocateStickies repositions sticky notes to follow their related nodes */
export function relocateStickies(workflow: FormatterWorkflow, graph: Graph): void {
  const stickyNotes = workflow.nodes.filter(isStickyNote);
  if (stickyNotes.length === 0) return;

  const regularNodes = workflow.nodes.filter((n) => !isStickyNote(n));
  if (regularNodes.length === 0) return;

  // Calculate the overall offset of the layout by comparing old and new positions
  // We need the pre-layout positions, which are stored in `original` on graph nodes
  let totalDx = 0;
  let totalDy = 0;
  let movedCount = 0;

  for (const node of regularNodes) {
    const graphNode = graph.nodes.get(node.name);
    if (graphNode) {
      totalDx += node.position[0] - graphNode.original.position[0];
      totalDy += node.position[1] - graphNode.original.position[1];
      movedCount++;
    }
  }

  const avgDx = movedCount > 0 ? totalDx / movedCount : 0;
  const avgDy = movedCount > 0 ? totalDy / movedCount : 0;

  for (const sticky of stickyNotes) {
    const stickyWidth = (sticky.parameters.width as number) ?? DEFAULT_STICKY_WIDTH;
    const stickyHeight = (sticky.parameters.height as number) ?? DEFAULT_STICKY_HEIGHT;
    const stickyRect = {
      x: sticky.position[0],
      y: sticky.position[1],
      w: stickyWidth,
      h: stickyHeight,
    };

    // Find regular nodes that were within this sticky note's bounds (using original positions)
    const relatedNodes: FormatterNode[] = [];
    for (const node of regularNodes) {
      const graphNode = graph.nodes.get(node.name);
      if (!graphNode) continue;

      const origX = graphNode.original.position[0];
      const origY = graphNode.original.position[1];

      if (
        origX >= stickyRect.x - STICKY_PADDING &&
        origX <= stickyRect.x + stickyRect.w + STICKY_PADDING &&
        origY >= stickyRect.y - STICKY_PADDING &&
        origY <= stickyRect.y + stickyRect.h + STICKY_PADDING
      ) {
        relatedNodes.push(node);
      }
    }

    if (relatedNodes.length > 0) {
      // Calculate bounding box of related nodes (after layout)
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (const node of relatedNodes) {
        minX = Math.min(minX, node.position[0]);
        maxX = Math.max(maxX, node.position[0]);
        maxY = Math.max(maxY, node.position[1]);
      }

      // Place sticky centered horizontally below the related nodes' bounding box
      const centerX = (minX + maxX) / 2;
      const newX = centerX - stickyWidth / 2;
      const newY = maxY + DEFAULT_NODE_HEIGHT + STICKY_PADDING;

      sticky.position = [snapToGrid(newX), snapToGrid(newY)];
    } else {
      // No related nodes: translate by the average offset
      sticky.position = [
        snapToGrid(sticky.position[0] + avgDx),
        snapToGrid(sticky.position[1] + avgDy),
      ];
    }
  }
}

/** FormatWorkflow formats a workflow file by reorganizing node positions */
export function formatWorkflow(filePath: string): ProcessResult {
  return formatWorkflowWithOptions(filePath, { dryRun: false });
}

/** FormatWorkflowWithOptions formats a workflow file with specified options */
export function formatWorkflowWithOptions(filePath: string, options: FormatOptions): ProcessResult {
  const result: ProcessResult = {
    filePath,
    success: false,
    changes: [],
  };

  let workflow: FormatterWorkflow;
  try {
    workflow = loadWorkflow(filePath);
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
    return result;
  }

  if (workflow.nodes.length === 0) {
    result.error = ErrEmptyWorkflow;
    return result;
  }

  const graph = buildFullGraph(workflow);

  if (graph.nodes.size === 0) {
    // Workflow only has sticky notes, nothing to format
    result.success = true;
    return result;
  }

  let composedGraph: Graph;
  try {
    composedGraph = layoutPipeline(graph);
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
    return result;
  }

  const changes = applyPositions(workflow, composedGraph);
  relocateStickies(workflow, composedGraph);

  if (!options.dryRun) {
    try {
      saveWorkflow(filePath, workflow);
    } catch (e) {
      result.error = e instanceof Error ? e : new Error(String(e));
      return result;
    }
  }

  result.success = true;
  result.changes = changes;
  return result;
}

/** FormatWorkflowAsync formats a workflow file (JSON/YAML) with specified options */
export async function formatWorkflowAsync(
  filePath: string,
  options: FormatOptions,
): Promise<ProcessResult> {
  const result: ProcessResult = {
    filePath,
    success: false,
    changes: [],
  };

  let workflow: FormatterWorkflow;
  try {
    workflow = await loadWorkflowAsync(filePath);
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
    return result;
  }

  if (workflow.nodes.length === 0) {
    result.error = ErrEmptyWorkflow;
    return result;
  }

  const graph = buildFullGraph(workflow);

  if (graph.nodes.size === 0) {
    result.success = true;
    return result;
  }

  let composedGraph: Graph;
  try {
    composedGraph = layoutPipeline(graph);
  } catch (e) {
    result.error = e instanceof Error ? e : new Error(String(e));
    return result;
  }

  const changes = applyPositions(workflow, composedGraph);
  relocateStickies(workflow, composedGraph);

  if (!options.dryRun) {
    try {
      saveWorkflow(filePath, workflow);
    } catch (e) {
      result.error = e instanceof Error ? e : new Error(String(e));
      return result;
    }
  }

  result.success = true;
  result.changes = changes;
  return result;
}

/** Runs the full layout pipeline: decompose → layout each → compose */
function layoutPipeline(graph: Graph): Graph {
  const subgraphs = decomposeSubgraphs(graph);
  for (const sg of subgraphs) {
    layoutSubgraph(sg);
  }
  return composeSubgraphs(subgraphs);
}
