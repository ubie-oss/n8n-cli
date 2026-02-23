import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  ErrEmptyWorkflow,
  ErrMissingNodes,
  type FormatterWorkflow,
  loadWorkflowAsync,
  saveWorkflow,
  serializeDeterministic,
  serializeDeterministicYaml,
  sortKeys,
} from "@/formatter/workflow.ts";

const minimalWorkflow = {
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
  ],
  connections: {},
};

describe("saveWorkflow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "save-wf-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saves JSON file normally", () => {
    const filePath = path.join(tmpDir, "wf.json");
    saveWorkflow(filePath, minimalWorkflow as FormatterWorkflow);
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe("Test");
  });

  test("saves YAML file for .yaml", () => {
    const filePath = path.join(tmpDir, "wf.yaml");
    saveWorkflow(filePath, minimalWorkflow as FormatterWorkflow);
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as { name: string };
    expect(parsed.name).toBe("Test");
  });

  test("saves YAML file for .yml", () => {
    const filePath = path.join(tmpDir, "wf.yml");
    saveWorkflow(filePath, minimalWorkflow as FormatterWorkflow);
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as { name: string };
    expect(parsed.name).toBe("Test");
  });
});

describe("loadWorkflowAsync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-async-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads a JSON file", async () => {
    const filePath = path.join(tmpDir, "wf.json");
    fs.writeFileSync(filePath, JSON.stringify(minimalWorkflow));

    const wf = await loadWorkflowAsync(filePath);
    expect(wf.name).toBe("Test");
    expect(wf.nodes).toHaveLength(1);
  });

  test("loads a YAML file", async () => {
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
connections: {}
`,
    );

    const wf = await loadWorkflowAsync(filePath);
    expect(wf.name).toBe("YAML Test");
    expect(wf.nodes).toHaveLength(1);
  });

  test("throws ErrMissingNodes for YAML without nodes", async () => {
    const filePath = path.join(tmpDir, "no-nodes.yaml");
    fs.writeFileSync(filePath, "name: Bad\nactive: false\nconnections: {}\n");

    await expect(loadWorkflowAsync(filePath)).rejects.toThrow(ErrMissingNodes);
  });

  test("throws ErrEmptyWorkflow for YAML with empty nodes", async () => {
    const filePath = path.join(tmpDir, "empty-nodes.yaml");
    fs.writeFileSync(filePath, "name: Empty\nactive: false\nnodes: []\nconnections: {}\n");

    await expect(loadWorkflowAsync(filePath)).rejects.toThrow(ErrEmptyWorkflow);
  });

  test("throws on invalid JSON file", async () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json");

    await expect(loadWorkflowAsync(filePath)).rejects.toThrow();
  });

  test("throws on invalid YAML file", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(filePath, ":\n  :\n  - : :\n  invalid: [unclosed");

    await expect(loadWorkflowAsync(filePath)).rejects.toThrow();
  });
});

describe("sortKeys", () => {
  test("sorts object keys alphabetically", () => {
    const result = sortKeys({ z: 1, a: 2, m: 3 });
    expect(Object.keys(result as object)).toEqual(["a", "m", "z"]);
  });

  test("sorts nested objects recursively", () => {
    const result = sortKeys({ z: { b: 1, a: 2 }, a: 3 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "z"]);
    expect(Object.keys(result.z as object)).toEqual(["a", "b"]);
  });

  test("sorts objects within arrays", () => {
    const result = sortKeys([{ z: 1, a: 2 }]) as unknown[];
    expect(Object.keys(result[0] as object)).toEqual(["a", "z"]);
  });

  test("returns primitives as-is", () => {
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys("hello")).toBe("hello");
    expect(sortKeys(null)).toBe(null);
  });
});

describe("serializeDeterministic", () => {
  test("sorts nodes by position (X primary, Y secondary)", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "2",
          name: "Second",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
        {
          id: "1",
          name: "First",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    };

    const json = serializeDeterministic(workflow);
    const parsed = JSON.parse(json);
    expect(parsed.nodes[0].name).toBe("First");
    expect(parsed.nodes[1].name).toBe("Second");
  });

  test("sorts keys alphabetically in output", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Start",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    };

    const json = serializeDeterministic(workflow);
    const keys = Object.keys(JSON.parse(json));
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  test("produces same output for same input (deterministic)", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "A",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: { z: 1, a: 2 },
        },
      ],
      connections: {},
    };

    const json1 = serializeDeterministic(workflow);
    const json2 = serializeDeterministic(workflow);
    expect(json1).toBe(json2);
  });
});

describe("serializeDeterministicYaml", () => {
  test("sorts nodes by position (X primary, Y secondary)", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "2",
          name: "Second",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
        {
          id: "1",
          name: "First",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    };

    const yamlStr = serializeDeterministicYaml(workflow);
    const parsed = yaml.load(yamlStr) as { nodes: { name: string }[] };
    expect(parsed.nodes[0]!.name).toBe("First");
    expect(parsed.nodes[1]!.name).toBe("Second");
  });

  test("sorts keys alphabetically in output", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "Start",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    };

    const yamlStr = serializeDeterministicYaml(workflow);
    const parsed = yaml.load(yamlStr) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  test("produces same output for same input (deterministic)", () => {
    const workflow: FormatterWorkflow = {
      name: "Test",
      active: false,
      nodes: [
        {
          id: "1",
          name: "A",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
          parameters: { z: 1, a: 2 },
        },
      ],
      connections: {},
    };

    const yaml1 = serializeDeterministicYaml(workflow);
    const yaml2 = serializeDeterministicYaml(workflow);
    expect(yaml1).toBe(yaml2);
  });
});
