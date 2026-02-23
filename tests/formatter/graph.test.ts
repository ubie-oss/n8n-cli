import { describe, expect, it } from "bun:test";
import { buildFullGraph, newGraph } from "../../src/formatter/graph.ts";
import type { FormatterWorkflow } from "../../src/formatter/workflow.ts";

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
  });
});
