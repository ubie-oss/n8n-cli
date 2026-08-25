import { describe, expect, test } from "bun:test";
import { report } from "../../src/apply/reporter.ts";
import type { ApplyOperation } from "../../src/apply/types.ts";
import { defaultOperation, emptyResult } from "../../src/apply/types.ts";
import type { WorkflowDiffDetail } from "../../src/diff/model.ts";

/**
 * The update section must fall back to the coarse field list when the detail
 * engine produced nothing (e.g. a position-only edit: the coarse differ counts
 * it as a node change, the detail engine ignores positions by default).
 */
function captureReport(ops: ApplyOperation[]): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (msg?: unknown) => lines.push(String(msg));
  try {
    report({ ...emptyResult(true), operations: ops });
  } finally {
    console.log = orig;
  }
  return lines;
}

function emptyDetail(): WorkflowDiffDetail {
  return {
    workflowId: "wf-1",
    workflowName: "w",
    metadataChanges: [],
    settingsChanges: [],
    pinDataChanges: [],
    nodeDiffs: [],
    edgeDiffs: [],
    unchangedNodes: [],
    unchangedEdges: [],
  };
}

function updateOp(overrides: Partial<ApplyOperation>): ApplyOperation {
  const op = defaultOperation("definitions/wf-1.yaml");
  return {
    ...op,
    operation: "update",
    workflowID: "wf-1",
    workflowName: "w",
    forced: false,
    tagsAdded: [],
    projectMoved: false,
    fromProject: "",
    toProject: "",
    threeWayUsed: false,
    threeWayReason: "",
    baseToLocalFields: [],
    baseToRemoteFields: [],
    ...overrides,
  };
}

describe("apply reporter — update detail fallback", () => {
  test("an empty detailDiff falls back to the coarse field list", () => {
    const lines = captureReport([
      updateOp({
        diff: {
          hasChanges: true,
          fields: [{ field: "nodes", oldValue: 3, newValue: 3 }],
        },
        detailDiff: emptyDetail(),
      }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("nodes: 3 → 3 nodes");
  });

  test("a populated detailDiff replaces the field list", () => {
    const lines = captureReport([
      updateOp({
        detailDiff: {
          ...emptyDetail(),
          metadataChanges: [{ path: "active", oldValue: true, newValue: false }],
        },
        diff: {
          hasChanges: true,
          fields: [{ field: "active", oldValue: true, newValue: false }],
        },
      }),
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("Metadata:");
    expect(joined).toContain("active: true → false");
    // The coarse field list must not duplicate the detail (it prints with a
    // leading "- " bullet).
    expect(joined).not.toContain("- active: true → false");
  });
});
