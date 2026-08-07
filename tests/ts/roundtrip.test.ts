import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { connectionsEqual, nodesEqual } from "@/apply/differ.ts";
import { generateTsWorkflow } from "@/ts/generator.ts";
import { parseTsWorkflow } from "@/ts/loader.ts";

/** Strips node IDs, which the `.ts` format deliberately does not carry. */
function withoutNodeIDs(nodes: Workflow["nodes"]): Workflow["nodes"] {
  return nodes.map(({ id: _id, ...rest }) => rest as Workflow["nodes"][number]);
}

function roundTrip(workflow: Workflow): Workflow {
  return parseTsWorkflow(generateTsWorkflow(workflow), workflow.id ?? "");
}

const simple: Workflow = {
  id: "wf-simple",
  name: "Simple",
  active: false,
  nodes: [
    {
      id: "n1",
      name: "Trigger",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [100, 300],
      parameters: {},
    },
    {
      id: "n2",
      name: "Set",
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      position: [320, 300],
      parameters: { mode: "manual" },
    },
  ],
  connections: {
    Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
  },
};

describe("JSON → TS → JSON round trip", () => {
  test("preserves name, nodes and connections", () => {
    const back = roundTrip(simple);

    expect(back.name).toBe(simple.name);
    expect(back.id).toBe(simple.id);
    expect(nodesEqual(withoutNodeIDs(back.nodes), withoutNodeIDs(simple.nodes))).toBe(true);
    expect(connectionsEqual(back.connections, simple.connections)).toBe(true);
  });

  test("preserves n8n expressions in parameters", () => {
    const workflow: Workflow = {
      ...simple,
      nodes: [
        simple.nodes[0]!,
        {
          ...simple.nodes[1]!,
          parameters: { value: "={{ $json.field }}", plain: "literal" },
        },
      ],
    };

    const back = roundTrip(workflow);

    expect(back.nodes[1]?.parameters).toEqual({
      value: "={{ $json.field }}",
      plain: "literal",
    });
  });

  test("carries active and tags through the meta block", () => {
    const workflow: Workflow = {
      ...simple,
      active: true,
      tags: [
        { id: "t1", name: "prod" },
        { id: "t2", name: "billing" },
      ],
    };

    const back = roundTrip(workflow);

    expect(back.active).toBe(true);
    expect(back.tags?.map((t) => t.name)).toEqual(["prod", "billing"]);
  });

  test("defaults active to false when there is no meta block", () => {
    expect(generateTsWorkflow(simple)).not.toContain("export const meta");
    expect(roundTrip(simple).active).toBe(false);
  });

  test("produces node IDs that are identical across runs", () => {
    const first = roundTrip(simple).nodes.map((n) => n.id);
    const second = roundTrip(simple).nodes.map((n) => n.id);

    expect(first).toEqual(second);
  });

  test("emits an import statement covering every SDK function used", () => {
    const code = generateTsWorkflow(simple);
    const importLine = code.split("\n")[0] ?? "";

    expect(importLine).toStartWith("import {");
    expect(importLine).toContain("@n8n/workflow-sdk");
    for (const fn of ["workflow", "trigger", "node"]) {
      expect(importLine).toContain(fn);
    }
  });

  test("the emitted file is accepted verbatim by the loader", () => {
    // Guards the contract between generator and preprocessor: the generator
    // writes an import the SDK itself would reject, and the loader must strip it.
    expect(() => parseTsWorkflow(generateTsWorkflow(simple), "wf-simple")).not.toThrow();
  });
});

describe("updatedAt", () => {
  test("survives the round trip so import can skip an up-to-date file", () => {
    const workflow: Workflow = { ...simple, updatedAt: "2026-08-07T00:00:00.000Z" };

    expect(generateTsWorkflow(workflow)).toContain('updatedAt: "2026-08-07T00:00:00.000Z"');
    expect(roundTrip(workflow).updatedAt).toBe("2026-08-07T00:00:00.000Z");
  });

  test("is omitted when the source has none", () => {
    expect(generateTsWorkflow(simple)).not.toContain("updatedAt");
    expect(roundTrip(simple).updatedAt).toBeUndefined();
  });
});
