import { describe, expect, it } from "bun:test";
import { type GraphNode, newGraph } from "../../src/formatter/graph.ts";
import { composeSubgraphs, decomposeSubgraphs } from "../../src/formatter/subgraph.ts";
import type { FormatterNode } from "../../src/formatter/workflow.ts";
import { SUBGRAPH_GAP } from "../../src/formatter/workflow.ts";

function makeNode(name: string): FormatterNode {
  return {
    id: name,
    name,
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  };
}

function makeGraphNode(name: string): GraphNode {
  return {
    name,
    original: makeNode(name),
    position: { x: 0, y: 0 },
  };
}

describe("decomposeSubgraphs", () => {
  it("returns empty array for empty graph", () => {
    const graph = newGraph();
    const subgraphs = decomposeSubgraphs(graph);
    expect(subgraphs).toEqual([]);
  });

  it("returns single subgraph for fully connected graph", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("C", makeGraphNode("C"));
    graph.edges = [
      { from: "A", to: "B", type: "main" },
      { from: "B", to: "C", type: "main" },
    ];

    const subgraphs = decomposeSubgraphs(graph);
    expect(subgraphs.length).toBe(1);
    expect(subgraphs[0]!.nodes.size).toBe(3);
    expect(subgraphs[0]!.edges.length).toBe(2);
  });

  it("decomposes two disconnected components", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("X", makeGraphNode("X"));
    graph.nodes.set("Y", makeGraphNode("Y"));
    graph.edges = [
      { from: "A", to: "B", type: "main" },
      { from: "X", to: "Y", type: "main" },
    ];

    const subgraphs = decomposeSubgraphs(graph);
    expect(subgraphs.length).toBe(2);

    // Components should be sorted by smallest node name
    const firstNames = [...subgraphs[0]!.nodes.keys()].sort();
    const secondNames = [...subgraphs[1]!.nodes.keys()].sort();
    expect(firstNames).toEqual(["A", "B"]);
    expect(secondNames).toEqual(["X", "Y"]);
  });

  it("handles isolated nodes as separate components", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("C", makeGraphNode("C"));
    // No edges

    const subgraphs = decomposeSubgraphs(graph);
    expect(subgraphs.length).toBe(3);
  });

  it("preserves edges within each component", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.nodes.set("C", makeGraphNode("C"));
    graph.nodes.set("X", makeGraphNode("X"));
    graph.edges = [
      { from: "A", to: "B", type: "main" },
      { from: "B", to: "C", type: "main" },
    ];

    const subgraphs = decomposeSubgraphs(graph);
    expect(subgraphs.length).toBe(2);

    const abcComponent = subgraphs.find((sg) => sg.nodes.has("A"))!;
    expect(abcComponent.edges.length).toBe(2);

    const xComponent = subgraphs.find((sg) => sg.nodes.has("X"))!;
    expect(xComponent.edges.length).toBe(0);
  });
});

describe("composeSubgraphs", () => {
  it("returns empty graph for empty input", () => {
    const composed = composeSubgraphs([]);
    expect(composed.nodes.size).toBe(0);
    expect(composed.edges).toEqual([]);
  });

  it("returns single subgraph normalized to y=0", () => {
    const sg = newGraph();
    const node = makeGraphNode("A");
    node.position = { x: 100, y: 50 };
    sg.nodes.set("A", node);

    const composed = composeSubgraphs([sg]);
    expect(composed.nodes.size).toBe(1);
    expect(composed.nodes.get("A")!.position.x).toBe(100);
    // Single subgraph with one node gets its minY normalized to 0
    expect(composed.nodes.get("A")!.position.y).toBe(0);
  });

  it("stacks subgraphs vertically with gap", () => {
    const sg1 = newGraph();
    const n1 = makeGraphNode("A");
    n1.position = { x: 0, y: 0 };
    sg1.nodes.set("A", n1);
    const n2 = makeGraphNode("B");
    n2.position = { x: 200, y: 100 };
    sg1.nodes.set("B", n2);

    const sg2 = newGraph();
    const n3 = makeGraphNode("X");
    n3.position = { x: 0, y: 0 };
    sg2.nodes.set("X", n3);

    const composed = composeSubgraphs([sg1, sg2]);
    expect(composed.nodes.size).toBe(3);

    // First subgraph starts at y=0
    expect(composed.nodes.get("A")!.position.y).toBe(0);
    expect(composed.nodes.get("B")!.position.y).toBe(100);

    // Second subgraph starts after first's maxY + SUBGRAPH_GAP
    expect(composed.nodes.get("X")!.position.y).toBe(100 + SUBGRAPH_GAP);
  });

  it("merges edges from all subgraphs", () => {
    const sg1 = newGraph();
    sg1.nodes.set("A", makeGraphNode("A"));
    sg1.nodes.set("B", makeGraphNode("B"));
    sg1.edges = [{ from: "A", to: "B", type: "main" }];

    const sg2 = newGraph();
    sg2.nodes.set("X", makeGraphNode("X"));
    sg2.nodes.set("Y", makeGraphNode("Y"));
    sg2.edges = [{ from: "X", to: "Y", type: "main" }];

    const composed = composeSubgraphs([sg1, sg2]);
    expect(composed.edges.length).toBe(2);
  });
});
