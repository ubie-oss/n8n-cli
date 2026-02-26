import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { formatWorkflowAsync, formatWorkflowWithOptions } from "@/formatter/formatter.ts";
import { AI_SUBNODE_Y_OFFSET, GRID_SIZE } from "@/formatter/workflow.ts";

const simpleWorkflow = {
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
      position: [500, 100],
      parameters: {},
    },
  ],
  connections: {
    Start: { main: [[{ node: "End", type: "main", index: 0 }]] },
  },
};

describe("formatWorkflowAsync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-async-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("formats a JSON file (dry-run)", async () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    const result = await formatWorkflowAsync(filePath, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("formats a JSON file and writes back", async () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    const result = await formatWorkflowAsync(filePath, { dryRun: false });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.name).toBe("Test");
  });

  test("formats a YAML file (dry-run)", async () => {
    const filePath = path.join(tmpDir, "wf.yaml");
    fs.writeFileSync(
      filePath,
      `name: YAML Test
active: false
nodes:
  - id: "1"
    name: Start
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
  - id: "2"
    name: End
    type: n8n-nodes-base.noOp
    typeVersion: 1
    position: [500, 100]
    parameters: {}
connections:
  Start:
    main:
      - - node: End
          type: main
          index: 0
`,
    );

    const result = await formatWorkflowAsync(filePath, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("formats a YAML file (non-dry-run) - writes back", async () => {
    const filePath = path.join(tmpDir, "wf.yaml");
    const yamlContent = `name: YAML Test
active: false
nodes:
  - id: "1"
    name: Start
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
  - id: "2"
    name: End
    type: n8n-nodes-base.noOp
    typeVersion: 1
    position: [500, 100]
    parameters: {}
connections:
  Start:
    main:
      - - node: End
          type: main
          index: 0
`;
    fs.writeFileSync(filePath, yamlContent);

    const result = await formatWorkflowAsync(filePath, { dryRun: false });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const afterContent = fs.readFileSync(filePath, "utf-8");
    // File should have been modified (written back as YAML)
    const parsed = yaml.load(afterContent) as { name: string };
    expect(parsed.name).toBe("YAML Test");
  });

  test("returns error for invalid file", async () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json");

    const result = await formatWorkflowAsync(filePath, { dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns changes list", async () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    const result = await formatWorkflowAsync(filePath, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

describe("formatWorkflowWithOptions (sync, existing)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("still works for JSON files", () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    const result = formatWorkflowWithOptions(filePath, { dryRun: true });
    expect(result.success).toBe(true);
  });
});

describe("idempotency", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-idempotent-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("formatting twice produces no changes on second run", () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    // First format
    const result1 = formatWorkflowWithOptions(filePath, { dryRun: false });
    expect(result1.success).toBe(true);

    const afterFirst = fs.readFileSync(filePath, "utf-8");

    // Second format
    const result2 = formatWorkflowWithOptions(filePath, { dryRun: false });
    expect(result2.success).toBe(true);
    expect(result2.changes.length).toBe(0);

    const afterSecond = fs.readFileSync(filePath, "utf-8");
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("deterministic JSON output", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-deterministic-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("output has sorted keys and position-sorted nodes", () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    formatWorkflowWithOptions(filePath, { dryRun: false });

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    // Top-level keys should be sorted
    const keys = Object.keys(content);
    expect(keys).toEqual([...keys].sort());

    // Nodes should be sorted by position
    for (let i = 1; i < content.nodes.length; i++) {
      const prev = content.nodes[i - 1];
      const curr = content.nodes[i];
      const prevKey = prev.position[0] * 1e6 + prev.position[1];
      const currKey = curr.position[0] * 1e6 + curr.position[1];
      expect(currKey).toBeGreaterThanOrEqual(prevKey);
    }
  });

  test("all positions are snapped to grid", () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(simpleWorkflow));

    formatWorkflowWithOptions(filePath, { dryRun: false });

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    for (const node of content.nodes) {
      expect(node.position[0] % GRID_SIZE).toBe(0);
      expect(node.position[1] % GRID_SIZE).toBe(0);
    }
  });
});

describe("sticky note relocation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-sticky-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sticky note covering nodes is relocated near them", () => {
    const workflow = {
      name: "Sticky Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Start",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [100, 100],
          parameters: {},
        },
        {
          id: "2",
          name: "End",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [300, 100],
          parameters: {},
        },
        {
          id: "3",
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          typeVersion: 1,
          position: [50, 50],
          parameters: { width: 400, height: 200 },
        },
      ],
      connections: {
        Start: { main: [[{ node: "End", type: "main", index: 0 }]] },
      },
    };

    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(workflow));

    formatWorkflowWithOptions(filePath, { dryRun: false });

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const sticky = content.nodes.find(
      (n: { type: string }) => n.type === "n8n-nodes-base.stickyNote",
    );

    // Sticky should have moved (not remain at original [50, 50])
    expect(sticky.position[0] !== 50 || sticky.position[1] !== 50).toBe(true);
    // Position should be grid-snapped
    expect(sticky.position[0] % GRID_SIZE).toBe(0);
    expect(sticky.position[1] % GRID_SIZE).toBe(0);
  });

  test("sticky note without related nodes is translated by average offset", () => {
    const workflow = {
      name: "Isolated Sticky Test",
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
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          typeVersion: 1,
          position: [5000, 5000],
          parameters: { width: 150, height: 150 },
        },
      ],
      connections: {},
    };

    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(workflow));

    formatWorkflowWithOptions(filePath, { dryRun: false });

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const sticky = content.nodes.find(
      (n: { type: string }) => n.type === "n8n-nodes-base.stickyNote",
    );

    // Sticky should be grid-snapped
    expect(sticky.position[0] % GRID_SIZE).toBe(0);
    expect(sticky.position[1] % GRID_SIZE).toBe(0);
  });
});

describe("disconnected components", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-disconnected-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("disconnected components are laid out separately", () => {
    const workflow = {
      name: "Disconnected Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "A",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "2",
          name: "B",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
        {
          id: "3",
          name: "X",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 500],
          parameters: {},
        },
        {
          id: "4",
          name: "Y",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [200, 500],
          parameters: {},
        },
      ],
      connections: {
        A: { main: [[{ node: "B", type: "main", index: 0 }]] },
        X: { main: [[{ node: "Y", type: "main", index: 0 }]] },
      },
    };

    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(workflow));

    const result = formatWorkflowWithOptions(filePath, { dryRun: false });
    expect(result.success).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const nodeMap = new Map(
      content.nodes.map((n: { name: string; position: number[] }) => [n.name, n.position]),
    );

    // Component 1 (A, B) and Component 2 (X, Y) should be separated vertically
    const posA = nodeMap.get("A") as number[];
    const posB = nodeMap.get("B") as number[];
    const posX = nodeMap.get("X") as number[];
    const posY = nodeMap.get("Y") as number[];
    const ayMax = Math.max(posA[1]!, posB[1]!);
    const xyMin = Math.min(posX[1]!, posY[1]!);
    expect(xyMin).toBeGreaterThan(ayMax);
  });
});

describe("!include preservation in YAML", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-include-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("!include tags are preserved after formatting", async () => {
    // Create a sub-file to include
    const subfileContent = "console.log('hello');";
    fs.writeFileSync(path.join(tmpDir, "code.js"), subfileContent);

    // Create a YAML workflow with !include
    const yamlContent = `name: Include Test
active: false
nodes:
  - id: "1"
    name: Start
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
  - id: "2"
    name: Code
    type: n8n-nodes-base.code
    typeVersion: 1
    position: [200, 0]
    parameters:
      jsCode: !include code.js
connections:
  Start:
    main:
      - - node: Code
          type: main
          index: 0
`;
    const filePath = path.join(tmpDir, "wf.yaml");
    fs.writeFileSync(filePath, yamlContent);

    const result = await formatWorkflowAsync(filePath, { dryRun: false });
    expect(result.success).toBe(true);

    const afterContent = fs.readFileSync(filePath, "utf-8");
    // The !include tag should be preserved in the output
    expect(afterContent).toContain("!include code.js");
    // The file content should NOT be inlined
    expect(afterContent).not.toContain("console.log('hello')");
  });

  test("!include tags survive formatting round-trip (dry-run)", async () => {
    fs.writeFileSync(path.join(tmpDir, "script.js"), "return 42;");

    const yamlContent = `name: DryRun Include
active: false
nodes:
  - id: "1"
    name: Trigger
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
  - id: "2"
    name: Run
    type: n8n-nodes-base.code
    typeVersion: 1
    position: [200, 0]
    parameters:
      jsCode: !include script.js
connections:
  Trigger:
    main:
      - - node: Run
          type: main
          index: 0
`;
    const filePath = path.join(tmpDir, "wf.yaml");
    fs.writeFileSync(filePath, yamlContent);

    const result = await formatWorkflowAsync(filePath, { dryRun: true });
    expect(result.success).toBe(true);

    // Original file should be untouched
    const afterContent = fs.readFileSync(filePath, "utf-8");
    expect(afterContent).toBe(yamlContent);
  });

  test("formatting twice produces identical output (idempotency)", async () => {
    fs.writeFileSync(path.join(tmpDir, "code.js"), "console.log('hello');");

    const yamlContent = `name: Idempotent Include
active: false
nodes:
  - id: "1"
    name: Start
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
  - id: "2"
    name: Code
    type: n8n-nodes-base.code
    typeVersion: 1
    position: [200, 0]
    parameters:
      jsCode: !include code.js
connections:
  Start:
    main:
      - - node: Code
          type: main
          index: 0
`;
    const filePath = path.join(tmpDir, "wf.yaml");
    fs.writeFileSync(filePath, yamlContent);

    // First format
    const r1 = await formatWorkflowAsync(filePath, { dryRun: false });
    expect(r1.success).toBe(true);
    const after1 = fs.readFileSync(filePath, "utf-8");

    // Second format
    const r2 = await formatWorkflowAsync(filePath, { dryRun: false });
    expect(r2.success).toBe(true);
    const after2 = fs.readFileSync(filePath, "utf-8");

    expect(after2).toBe(after1);
    expect(r2.changes.length).toBe(0);
    // !include must still be present
    expect(after2).toContain("!include code.js");
  });

  test("!include in nested parameters is preserved", async () => {
    fs.writeFileSync(path.join(tmpDir, "template.html"), "<h1>Hello</h1>");

    const yamlContent = `name: Nested Include
active: false
nodes:
  - id: "1"
    name: Start
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
  - id: "2"
    name: Email
    type: n8n-nodes-base.emailSend
    typeVersion: 1
    position: [200, 0]
    parameters:
      options:
        htmlBody: !include template.html
connections:
  Start:
    main:
      - - node: Email
          type: main
          index: 0
`;
    const filePath = path.join(tmpDir, "wf.yaml");
    fs.writeFileSync(filePath, yamlContent);

    const result = await formatWorkflowAsync(filePath, { dryRun: false });
    expect(result.success).toBe(true);

    const afterContent = fs.readFileSync(filePath, "utf-8");
    expect(afterContent).toContain("!include template.html");
    expect(afterContent).not.toContain("<h1>Hello</h1>");
  });
});

describe("ai_* connections", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmt-ai-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ai_* connected nodes are placed below their parent Agent", () => {
    const workflow = {
      name: "AI Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "2",
          name: "Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 1,
          position: [500, 0],
          parameters: {},
        },
        {
          id: "3",
          name: "ChatModel",
          type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
          typeVersion: 1,
          position: [1000, 500],
          parameters: {},
        },
        {
          id: "4",
          name: "Tool",
          type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
          typeVersion: 1,
          position: [1000, 700],
          parameters: {},
        },
      ],
      connections: {
        Trigger: {
          main: [[{ node: "Agent", type: "main", index: 0 }]],
        },
        ChatModel: {
          ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]],
        },
        Tool: {
          ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]],
        },
      },
    };

    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(workflow));

    const result = formatWorkflowWithOptions(filePath, { dryRun: false });
    expect(result.success).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const nodeMap = new Map(
      content.nodes.map((n: { name: string; position: number[] }) => [n.name, n.position]),
    );

    const agentPos = nodeMap.get("Agent") as number[];
    const chatModelPos = nodeMap.get("ChatModel") as number[];
    const toolPos = nodeMap.get("Tool") as number[];

    // AI sub-nodes should be below Agent, stacked vertically
    expect(chatModelPos[1]!).toBeGreaterThan(agentPos[1]!);
    expect(toolPos[1]!).toBeGreaterThan(chatModelPos[1]!);

    // AI sub-nodes should share same X as Agent
    expect(chatModelPos[0]).toBe(agentPos[0]);
    expect(toolPos[0]).toBe(agentPos[0]);

    // Trigger should be to the left of Agent (main flow)
    const triggerPos = nodeMap.get("Trigger") as number[];
    expect(triggerPos[0]!).toBeLessThan(agentPos[0]!);
  });

  test("ai_* sub-node workflow is idempotent", () => {
    const workflow = {
      name: "AI Idempotent",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          id: "2",
          name: "Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 1,
          position: [500, 0],
          parameters: {},
        },
        {
          id: "3",
          name: "ChatModel",
          type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
          typeVersion: 1,
          position: [1000, 500],
          parameters: {},
        },
        {
          id: "4",
          name: "Tool",
          type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
          typeVersion: 1,
          position: [1000, 700],
          parameters: {},
        },
      ],
      connections: {
        Trigger: {
          main: [[{ node: "Agent", type: "main", index: 0 }]],
        },
        ChatModel: {
          ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]],
        },
        Tool: {
          ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]],
        },
      },
    };

    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(workflow));

    // First format
    const r1 = formatWorkflowWithOptions(filePath, { dryRun: false });
    expect(r1.success).toBe(true);
    const after1 = fs.readFileSync(filePath, "utf-8");

    // Second format
    const r2 = formatWorkflowWithOptions(filePath, { dryRun: false });
    expect(r2.success).toBe(true);
    expect(r2.changes.length).toBe(0);

    const after2 = fs.readFileSync(filePath, "utf-8");
    expect(after2).toBe(after1);
  });
});
