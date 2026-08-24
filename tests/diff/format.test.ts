import { describe, expect, test } from "bun:test";
import {
  formatDetailLines,
  formatDiffMermaid,
  formatDiffStat,
  formatDiffText,
} from "../../src/diff/format.ts";
import type {
  DiffReport,
  NodeDiff,
  WorkflowComparison,
  WorkflowDiffDetail,
} from "../../src/diff/model.ts";

function detail(overrides: Partial<WorkflowDiffDetail> = {}): WorkflowDiffDetail {
  return {
    workflowId: "wf-1",
    workflowName: "Nightly sync",
    metadataChanges: [],
    settingsChanges: [],
    pinDataChanges: [],
    nodeDiffs: [],
    edgeDiffs: [],
    ...overrides,
  };
}

function comparison(overrides: Partial<WorkflowComparison> = {}): WorkflowComparison {
  return {
    status: "modified",
    workflowId: "wf-1",
    name: "Nightly sync",
    detail: detail(),
    ...overrides,
  };
}

const modifiedNode: NodeDiff = {
  kind: "modified",
  nodeId: "n2",
  name: "HTTP Request",
  type: "n8n-nodes-base.httpRequest",
  parameterChanges: [{ path: "parameters.url", oldValue: "https://a", newValue: "https://b" }],
  otherChanges: [],
};

describe("formatDiffText", () => {
  test("no changes message", () => {
    const report: DiffReport = { hasChanges: false, comparisons: [] };
    expect(formatDiffText(report)).toContain("No differences found.");
  });

  test("summary lines and detail block for modified workflows", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({ detail: detail({ nodeDiffs: [modifiedNode] }) }),
        comparison({ status: "unchanged", name: "Other", workflowId: "wf-2", detail: undefined }),
      ],
    };
    const text = formatDiffText(report);
    expect(text).toContain("M Nightly sync (id: wf-1)  ~1 nodes");
    expect(text).toContain("= Other (id: wf-2) (no changes)");
    expect(text).toContain("=== Nightly sync (id: wf-1) ===");
    expect(text).toContain('~ "HTTP Request":');
    expect(text).toContain('parameters.url: "https://a" → "https://b"');
  });

  test("stat mode omits the detail block", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison({ detail: detail({ nodeDiffs: [modifiedNode] }) })],
    };
    const text = formatDiffText(report, true);
    expect(text).toContain("M Nightly sync");
    expect(text).not.toContain("=== ");
  });

  test("added/removed workflows are marked with side hints", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({ status: "removed", detail: undefined }),
        comparison({ status: "added", name: "New one", detail: undefined }),
      ],
    };
    const text = formatDiffText(report);
    expect(text).toContain("- Nightly sync (id: wf-1) [only on left side]");
    expect(text).toContain("+ New one (id: wf-1) [new on right side]");
  });

  test("line-level changes render as +/- lines under the path", () => {
    const lines = formatDetailLines(
      detail({
        nodeDiffs: [
          {
            kind: "modified",
            name: "Code",
            type: "n8n-nodes-base.code",
            parameterChanges: [
              {
                path: "parameters.jsCode",
                lineChanges: [
                  { kind: "removed", lineNumber: 1, text: "const a = 1;" },
                  { kind: "added", lineNumber: 1, text: "const a = 2;" },
                ],
              },
            ],
            otherChanges: [],
          },
        ],
      }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("parameters.jsCode:");
    expect(joined).toContain("- const a = 1;");
    expect(joined).toContain("+ const a = 2;");
  });
});

describe("formatDiffStat", () => {
  test("one line per workflow with counts", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            nodeDiffs: [modifiedNode, { ...modifiedNode, name: "Second" }],
            edgeDiffs: [
              {
                kind: "added",
                source: "A",
                target: "B",
                connectionType: "main",
                sourceOutputIndex: 0,
                targetInputIndex: 0,
              },
            ],
          }),
        }),
      ],
    };
    expect(formatDiffStat(report)).toContain("~2 nodes, ~connections (1)");
  });

  test("metadata-only changes still show up", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            metadataChanges: [{ path: "active", oldValue: false, newValue: true }],
          }),
        }),
      ],
    };
    expect(formatDiffStat(report)).toContain("metadata");
  });
});

describe("formatDiffMermaid", () => {
  test("emits classDefs and changed nodes with change classes", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            nodeDiffs: [
              modifiedNode,
              {
                kind: "added",
                name: "Slack",
                type: "n8n-nodes-base.slack",
                parameterChanges: [],
                otherChanges: [],
              },
              {
                kind: "renamed",
                name: "Fetch Users",
                oldName: "Fetch Data",
                type: "n8n-nodes-base.httpRequest",
                parameterChanges: [],
                otherChanges: [],
              },
            ],
            edgeDiffs: [
              {
                kind: "added",
                source: "HTTP Request",
                target: "Slack",
                connectionType: "main",
                sourceOutputIndex: 0,
                targetInputIndex: 0,
              },
            ],
          }),
        }),
      ],
    };
    const mmd = formatDiffMermaid(report);
    expect(mmd).toContain("flowchart LR");
    expect(mmd).toContain(":::added");
    expect(mmd).toContain(":::modified");
    expect(mmd).toContain(":::renamed");
    expect(mmd).toContain("HTTP_Request -->|main| Slack:::edgeAdded");
    expect(mmd).toContain("classDef added fill:");
    expect(mmd).toContain("Fetch_Data -. renamed .-> Fetch_Users");
  });

  test("unchanged workflows produce no diagram", () => {
    const report: DiffReport = {
      hasChanges: false,
      comparisons: [comparison({ status: "unchanged", detail: undefined })],
    };
    expect(formatDiffMermaid(report)).toBe("");
  });

  test("node names sanitize into valid mermaid ids", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          name: "1st try",
          detail: detail({
            nodeDiffs: [
              {
                kind: "added",
                name: "1st node!",
                type: "t",
                parameterChanges: [],
                otherChanges: [],
              },
            ],
          }),
        }),
      ],
    };
    const mmd = formatDiffMermaid(report);
    expect(mmd).toContain('n1st_node(["1st node!"]):::added');
  });
});
