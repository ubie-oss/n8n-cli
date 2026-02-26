import { describe, expect, it } from "bun:test";
import {
  buildFullGraph,
  extractAiClusters,
  type GraphNode,
  newGraph,
} from "../../src/formatter/graph.ts";
import type { FormatterNode, FormatterWorkflow } from "../../src/formatter/workflow.ts";

describe("newGraph", () => {
  it("creates an empty graph", () => {
    const graph = newGraph();
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges).toEqual([]);
  });
});

describe("buildFullGraph", () => {
  it("builds graph from simple workflow", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Start",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "2",
          name: "HTTP Request",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
        {
          id: "3",
          name: "End",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [400, 0],
          parameters: {},
        },
      ],
      connections: {
        Start: {
          main: [[{ node: "HTTP Request", type: "main", index: 0 }]],
        },
        "HTTP Request": {
          main: [[{ node: "End", type: "main", index: 0 }]],
        },
      },
    };

    const graph = buildFullGraph(workflow);

    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.has("Start")).toBe(true);
    expect(graph.nodes.has("HTTP Request")).toBe(true);
    expect(graph.nodes.has("End")).toBe(true);

    expect(graph.edges.length).toBe(2);

    const edgeMap = new Map(graph.edges.map((e) => [e.from, e.to]));
    expect(edgeMap.get("Start")).toBe("HTTP Request");
    expect(edgeMap.get("HTTP Request")).toBe("End");

    // All edges should have type "main"
    for (const edge of graph.edges) {
      expect(edge.type).toBe("main");
    }
  });

  it("excludes sticky notes from graph", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Start",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "2",
          name: "End",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
        {
          id: "3",
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          typeVersion: 1,
          position: [100, 200],
          parameters: {},
        },
      ],
      connections: {
        Start: {
          main: [[{ node: "End", type: "main", index: 0 }]],
        },
      },
    };

    const graph = buildFullGraph(workflow);

    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.has("Note")).toBe(false);
  });

  it("includes ai_* connection types as edges", () => {
    const workflow: FormatterWorkflow = {
      name: "AI Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "2",
          name: "ChatModel",
          type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
          typeVersion: 1,
          position: [0, 200],
          parameters: {},
        },
        {
          id: "3",
          name: "Tool",
          type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
          typeVersion: 1,
          position: [0, 400],
          parameters: {},
        },
        {
          id: "4",
          name: "Memory",
          type: "@n8n/n8n-nodes-langchain.memoryBufferWindow",
          typeVersion: 1,
          position: [0, 600],
          parameters: {},
        },
      ],
      connections: {
        ChatModel: {
          ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]],
        },
        Tool: {
          ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]],
        },
        Memory: {
          ai_memory: [[{ node: "Agent", type: "ai_memory", index: 0 }]],
        },
      },
    };

    const graph = buildFullGraph(workflow);

    expect(graph.nodes.size).toBe(4);
    expect(graph.edges.length).toBe(3);

    const targets = graph.edges.map((e) => e.to);
    expect(targets.every((t) => t === "Agent")).toBe(true);

    const sources = graph.edges.map((e) => e.from).sort();
    expect(sources).toEqual(["ChatModel", "Memory", "Tool"]);

    // Each edge should have the correct AI type
    const typeMap = new Map(graph.edges.map((e) => [e.from, e.type]));
    expect(typeMap.get("ChatModel")).toBe("ai_languageModel");
    expect(typeMap.get("Tool")).toBe("ai_tool");
    expect(typeMap.get("Memory")).toBe("ai_memory");
  });
});

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

describe("extractAiClusters", () => {
  it("extracts Agent and sub-nodes correctly", () => {
    const graph = newGraph();
    graph.nodes.set("Trigger", makeGraphNode("Trigger"));
    graph.nodes.set("Agent", makeGraphNode("Agent"));
    graph.nodes.set("ChatModel", makeGraphNode("ChatModel"));
    graph.nodes.set("Tool", makeGraphNode("Tool"));
    graph.nodes.set("Memory", makeGraphNode("Memory"));
    graph.edges = [
      { from: "Trigger", to: "Agent", type: "main" },
      { from: "ChatModel", to: "Agent", type: "ai_languageModel" },
      { from: "Tool", to: "Agent", type: "ai_tool" },
      { from: "Memory", to: "Agent", type: "ai_memory" },
    ];

    const clusters = extractAiClusters(graph);

    expect(clusters.length).toBe(1);
    expect(clusters[0]!.agentName).toBe("Agent");
    expect(clusters[0]!.subNodeNames).toEqual(["ChatModel", "Memory", "Tool"]);
  });

  it("returns empty array for workflow without AI nodes", () => {
    const graph = newGraph();
    graph.nodes.set("A", makeGraphNode("A"));
    graph.nodes.set("B", makeGraphNode("B"));
    graph.edges = [{ from: "A", to: "B", type: "main" }];

    const clusters = extractAiClusters(graph);
    expect(clusters).toEqual([]);
  });

  it("handles sub-node chain (Model → OutputParser → Agent)", () => {
    const graph = newGraph();
    graph.nodes.set("Agent", makeGraphNode("Agent"));
    graph.nodes.set("Model", makeGraphNode("Model"));
    graph.nodes.set("OutputParser", makeGraphNode("OutputParser"));
    graph.edges = [
      { from: "Model", to: "OutputParser", type: "ai_languageModel" },
      { from: "OutputParser", to: "Agent", type: "ai_outputParser" },
    ];

    const clusters = extractAiClusters(graph);

    expect(clusters.length).toBe(1);
    expect(clusters[0]!.agentName).toBe("Agent");
    expect(clusters[0]!.subNodeNames).toEqual(["Model", "OutputParser"]);
  });

  it("handles multiple Agents with separate sub-nodes", () => {
    const graph = newGraph();
    graph.nodes.set("Agent1", makeGraphNode("Agent1"));
    graph.nodes.set("Agent2", makeGraphNode("Agent2"));
    graph.nodes.set("Model1", makeGraphNode("Model1"));
    graph.nodes.set("Model2", makeGraphNode("Model2"));
    graph.edges = [
      { from: "Agent1", to: "Agent2", type: "main" },
      { from: "Model1", to: "Agent1", type: "ai_languageModel" },
      { from: "Model2", to: "Agent2", type: "ai_languageModel" },
    ];

    const clusters = extractAiClusters(graph);

    expect(clusters.length).toBe(2);
    expect(clusters[0]!.agentName).toBe("Agent1");
    expect(clusters[0]!.subNodeNames).toEqual(["Model1"]);
    expect(clusters[1]!.agentName).toBe("Agent2");
    expect(clusters[1]!.subNodeNames).toEqual(["Model2"]);
  });
});
