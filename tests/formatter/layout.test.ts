import { describe, expect, it } from "bun:test";
import { type GraphNode, newGraph } from "../../src/formatter/graph.ts";
import { layoutSubgraph } from "../../src/formatter/layout.ts";
import type { FormatterNode } from "../../src/formatter/workflow.ts";
import { GRID_SIZE } from "../../src/formatter/workflow.ts";

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
      { from: "A", to: "B" },
      { from: "B", to: "C" },
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
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
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
    graph.edges = [{ from: "A", to: "A" }];

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
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
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
});
