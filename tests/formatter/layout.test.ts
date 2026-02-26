import { describe, expect, it } from "bun:test";
import { type GraphNode, newGraph } from "../../src/formatter/graph.ts";
import { layoutSubgraph } from "../../src/formatter/layout.ts";
import type { FormatterNode } from "../../src/formatter/workflow.ts";
import { AI_SUBNODE_Y_OFFSET, AI_SUBNODE_Y_SEP, GRID_SIZE } from "../../src/formatter/workflow.ts";

function makeNode(name: string, position: [number, number] = [0, 0]): FormatterNode {
  return {
    id: name,
    name,
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position,
    parameters: {},
  };
}

function makeGraphNode(name: string, position: [number, number] = [0, 0]): GraphNode {
  return {
    name,
    original: makeNode(name, position),
    position: { x: 0, y: 0 },
  };
}

describe("layoutSubgraph", () => {
  it("lays out linear chain A → B → C left-to-right", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("C", makeGraphNode("C"));
    graph.edges = [
      { from: "A", to: "B", type: "main" },
      { from: "B", to: "C", type: "main" },
    ];

    layoutSubgraph(graph);

    const ax = graph.nodes.get("A")!.position.x;
    const bx = graph.nodes.get("B")!.position.x;
    const cx = graph.nodes.get("C")!.position.x;

    // A should be leftmost, B in middle, C rightmost
    expect(ax).toBeLessThan(bx);
    expect(bx).toBeLessThan(cx);

    // All positions should be snapped to grid
    for (const node of graph.nodes.values()) {
      expect(node.position.x % GRID_SIZE).toBe(0);
      expect(node.position.y % GRID_SIZE).toBe(0);
    }
  });

  it("handles cyclic graph (loop structure)", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("C", makeGraphNode("C"));
    graph.edges = [
      { from: "A", to: "B", type: "main" },
      { from: "B", to: "C", type: "main" },
      { from: "C", to: "A", type: "main" },
    ];

    layoutSubgraph(graph);

    // All positions should be snapped to grid
    for (const node of graph.nodes.values()) {
      expect(node.position.x % GRID_SIZE).toBe(0);
      expect(node.position.y % GRID_SIZE).toBe(0);
    }
  });

  it("handles self-loop", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.edges = [{ from: "A", to: "A", type: "main" }];

    layoutSubgraph(graph);

    // Position should be snapped to grid
    expect(graph.nodes.get("A")!.position.x % GRID_SIZE).toBe(0);
    expect(graph.nodes.get("A")!.position.y % GRID_SIZE).toBe(0);
  });

  it("handles branching/merging (diamond) graph", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("C", makeGraphNode("C"));
    graph.nodes.set("D", makeGraphNode("D"));
    graph.edges = [
      { from: "A", to: "B", type: "main" },
      { from: "A", to: "C", type: "main" },
      { from: "B", to: "D", type: "main" },
      { from: "C", to: "D", type: "main" },
    ];

    layoutSubgraph(graph);

    const ax = graph.nodes.get("A")!.position.x;
    const bx = graph.nodes.get("B")!.position.x;
    const cx = graph.nodes.get("C")!.position.x;
    const dx = graph.nodes.get("D")!.position.x;

    // A should be leftmost, D should be rightmost
    expect(ax).toBeLessThan(bx);
    expect(ax).toBeLessThan(cx);
    expect(bx).toBeLessThan(dx);
    expect(cx).toBeLessThan(dx);

    // B and C should be at the same X (same rank)
    expect(bx).toBe(cx);

    // B and C should have different Y positions
    expect(graph.nodes.get("B")!.position.y).not.toBe(graph.nodes.get("C")!.position.y);
  });

  it("handles single node graph", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));

    layoutSubgraph(graph);

    // Should succeed without error
    expect(graph.nodes.get("A")!.position.x % GRID_SIZE).toBe(0);
    expect(graph.nodes.get("A")!.position.y % GRID_SIZE).toBe(0);
  });

  it("handles empty graph", () => {
    const graph = newGraph();
    // Should succeed without error
    layoutSubgraph(graph);
  });

  it("handles disconnected nodes within a subgraph", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    // No edges

    layoutSubgraph(graph);

    // Both should have valid positions
    for (const node of graph.nodes.values()) {
      expect(node.position.x % GRID_SIZE).toBe(0);
      expect(node.position.y % GRID_SIZE).toBe(0);
    }
  });

  it("places AI sub-nodes vertically below Agent", () => {
    const graph = newGraph();
    graph.nodes.set("Trigger", makeGraphNode("Trigger"));
    graph.nodes.set("Agent", makeGraphNode("Agent"));
    graph.nodes.set("ChatModel", makeGraphNode("ChatModel"));
    graph.nodes.set("Tool", makeGraphNode("Tool"));
    graph.edges = [
      { from: "Trigger", to: "Agent", type: "main" },
      { from: "ChatModel", to: "Agent", type: "ai_languageModel" },
      { from: "Tool", to: "Agent", type: "ai_tool" },
    ];

    layoutSubgraph(graph);

    const agentX = graph.nodes.get("Agent")!.position.x;
    const agentY = graph.nodes.get("Agent")!.position.y;
    const chatModelPos = graph.nodes.get("ChatModel")!.position;
    const toolPos = graph.nodes.get("Tool")!.position;

    // Sub-nodes sorted by name: ChatModel, Tool
    // First sub-node at agent.y + Y_OFFSET, second at agent.y + Y_OFFSET + Y_SEP
    const expectedY0 = Math.round((agentY + AI_SUBNODE_Y_OFFSET) / GRID_SIZE) * GRID_SIZE;
    const expectedY1 =
      Math.round((agentY + AI_SUBNODE_Y_OFFSET + AI_SUBNODE_Y_SEP) / GRID_SIZE) * GRID_SIZE;
    expect(chatModelPos.y).toBe(expectedY0);
    expect(toolPos.y).toBe(expectedY1);

    // All sub-nodes should share the same X as Agent
    expect(chatModelPos.x).toBe(agentX);
    expect(toolPos.x).toBe(agentX);

    // All positions should be snapped to grid
    for (const node of graph.nodes.values()) {
      expect(node.position.x % GRID_SIZE).toBe(0);
      expect(node.position.y % GRID_SIZE).toBe(0);
    }
  });

  it("places multiple AI sub-nodes vertically with equal spacing", () => {
    const graph = newGraph();
    graph.nodes.set("Agent", makeGraphNode("Agent"));
    graph.nodes.set("ChatModel", makeGraphNode("ChatModel"));
    graph.nodes.set("Memory", makeGraphNode("Memory"));
    graph.nodes.set("Tool", makeGraphNode("Tool"));
    graph.edges = [
      { from: "ChatModel", to: "Agent", type: "ai_languageModel" },
      { from: "Memory", to: "Agent", type: "ai_memory" },
      { from: "Tool", to: "Agent", type: "ai_tool" },
    ];

    layoutSubgraph(graph);

    // Sub-nodes sorted by name: ChatModel, Memory, Tool — all stacked vertically
    const chatModelY = graph.nodes.get("ChatModel")!.position.y;
    const memoryY = graph.nodes.get("Memory")!.position.y;
    const toolY = graph.nodes.get("Tool")!.position.y;

    // Each subsequent sub-node should be below the previous
    expect(chatModelY).toBeLessThan(memoryY);
    expect(memoryY).toBeLessThan(toolY);

    // Spacing should be approximately equal (within grid snap tolerance)
    const spacing1 = memoryY - chatModelY;
    const spacing2 = toolY - memoryY;
    expect(Math.abs(spacing1 - spacing2)).toBeLessThanOrEqual(GRID_SIZE);

    // All sub-nodes should share the same X
    const chatModelX = graph.nodes.get("ChatModel")!.position.x;
    const memoryX = graph.nodes.get("Memory")!.position.x;
    const toolX = graph.nodes.get("Tool")!.position.x;
    expect(chatModelX).toBe(memoryX);
    expect(memoryX).toBe(toolX);
  });

  it("main-flow layout is unaffected by AI sub-nodes", () => {
    // Layout without AI sub-nodes
    const graphWithoutAi = newGraph();
    graphWithoutAi.nodes.set("Trigger", makeGraphNode("Trigger"));
    graphWithoutAi.nodes.set("Agent", makeGraphNode("Agent"));
    graphWithoutAi.nodes.set("End", makeGraphNode("End"));
    graphWithoutAi.edges = [
      { from: "Trigger", to: "Agent", type: "main" },
      { from: "Agent", to: "End", type: "main" },
    ];

    layoutSubgraph(graphWithoutAi);

    const triggerPos1 = { ...graphWithoutAi.nodes.get("Trigger")!.position };
    const agentPos1 = { ...graphWithoutAi.nodes.get("Agent")!.position };
    const endPos1 = { ...graphWithoutAi.nodes.get("End")!.position };

    // Layout with AI sub-nodes
    const graphWithAi = newGraph();
    graphWithAi.nodes.set("Trigger", makeGraphNode("Trigger"));
    graphWithAi.nodes.set("Agent", makeGraphNode("Agent"));
    graphWithAi.nodes.set("End", makeGraphNode("End"));
    graphWithAi.nodes.set("ChatModel", makeGraphNode("ChatModel"));
    graphWithAi.edges = [
      { from: "Trigger", to: "Agent", type: "main" },
      { from: "Agent", to: "End", type: "main" },
      { from: "ChatModel", to: "Agent", type: "ai_languageModel" },
    ];

    layoutSubgraph(graphWithAi);

    // Main-flow positions should be identical
    expect(graphWithAi.nodes.get("Trigger")!.position).toEqual(triggerPos1);
    expect(graphWithAi.nodes.get("Agent")!.position).toEqual(agentPos1);
    expect(graphWithAi.nodes.get("End")!.position).toEqual(endPos1);
  });
});
