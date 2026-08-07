import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { deriveNodeId, stableNodeIdMap } from "@/ts/node-ids.ts";

describe("deriveNodeId", () => {
  test("is stable across calls", () => {
    expect(deriveNodeId("wf1", "Start")).toBe(deriveNodeId("wf1", "Start"));
  });

  test("differs per node name", () => {
    expect(deriveNodeId("wf1", "Start")).not.toBe(deriveNodeId("wf1", "End"));
  });

  test("differs per workflow, so two workflows sharing node names never collide", () => {
    expect(deriveNodeId("wf1", "Start")).not.toBe(deriveNodeId("wf2", "Start"));
  });

  test("looks like a v4-shaped UUID so n8n accepts it", () => {
    expect(deriveNodeId("wf1", "Start")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("stableNodeIdMap", () => {
  test("derives an ID for every requested node", () => {
    const map = stableNodeIdMap("wf1", ["A", "B"]);

    expect([...map.keys()].sort()).toEqual(["A", "B"]);
    expect(map.get("A")).toBe(deriveNodeId("wf1", "A"));
  });

  test("reuses IDs from an existing workflow so conversion does not churn them", () => {
    const existing: Workflow = {
      id: "wf1",
      name: "w",
      active: false,
      nodes: [
        {
          id: "original-id",
          name: "A",
          type: "n8n-nodes-base.noOp",
          typeVersion: 1,
          position: [0, 0],
        },
      ],
      connections: {},
    };

    const map = stableNodeIdMap("wf1", ["A", "B"], existing);

    expect(map.get("A")).toBe("original-id");
    expect(map.get("B")).toBe(deriveNodeId("wf1", "B"));
  });
});
