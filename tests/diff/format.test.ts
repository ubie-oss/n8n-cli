import { describe, expect, test } from "bun:test";
import {
  formatDetailLines,
  formatDiffMermaid,
  formatDiffStat,
  formatDiffText,
} from "../../src/diff/format.ts";
import { formatDiffHtml } from "../../src/diff/format-html.ts";
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
    unchangedNodes: [],
    unchangedEdges: [],
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
    expect(mmd).toContain("HTTP_Request -->|main| Slack");
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

describe("formatDiffHtml", () => {
  test("renders status badges, escaped values and line diffs", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            metadataChanges: [{ path: "active", oldValue: true, newValue: false }],
            nodeDiffs: [
              {
                kind: "modified",
                name: "Code <injected>",
                type: "n8n-nodes-base.code",
                parameterChanges: [
                  {
                    path: "parameters.jsCode",
                    lineChanges: [
                      { kind: "removed", lineNumber: 1, text: '<script>alert("x")</script>' },
                      { kind: "added", lineNumber: 1, text: "const a = 2;" },
                    ],
                  },
                ],
                otherChanges: [],
              },
            ],
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
    const html = formatDiffHtml(report);
    expect(html).toContain('<span class="status modified">M modified</span>');
    expect(html).toContain("<b>1</b>");
    // XSS-safe: raw markup never survives escaping.
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('class="dline removed"');
    expect(html).toContain('class="dline added"');
    expect(html).toContain('class="dline ctx"');
  });

  test("unchanged-only reports render an empty badge set", () => {
    const report: DiffReport = {
      hasChanges: false,
      comparisons: [comparison({ status: "unchanged", detail: undefined })],
    };
    expect(formatDiffHtml(report)).toContain("no changes");
  });
});

describe("formatDiffMermaid — full graph rendering", () => {
  test("unchanged nodes render gray and unchanged edges get their own class", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            nodeDiffs: [
              {
                kind: "added",
                name: "Slack",
                type: "n8n-nodes-base.slack",
                parameterChanges: [],
                otherChanges: [],
              },
            ],
            edgeDiffs: [
              {
                kind: "removed",
                source: "Trigger",
                target: "HTTP Request",
                connectionType: "main",
                sourceOutputIndex: 0,
                targetInputIndex: 0,
              },
            ],
            unchangedNodes: [{ name: "HTTP Request", type: "n8n-nodes-base.httpRequest" }],
            unchangedEdges: [
              {
                source: "Trigger",
                target: "HTTP Request",
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
    expect(mmd).toContain('HTTP_Request(["HTTP Request"]):::unchanged');
    expect(mmd).toContain("Trigger -->|main| HTTP_Request");
    expect(mmd).toContain("linkStyle 0 stroke:#b3b9c2,stroke-width:1.5px");
    expect(mmd).toContain("linkStyle 1 stroke:#a8071a,stroke-width:2.5px,stroke-dasharray:6");
    expect(mmd).toContain("classDef unchanged fill:#e4e7eb");
  });
});

describe("formatDiffHtml — full parameters on add/delete", () => {
  test("added nodes render every parameter as a + line", async () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            nodeDiffs: [
              {
                kind: "added",
                name: "New HTTP",
                type: "n8n-nodes-base.httpRequest",
                parameterChanges: [],
                otherChanges: [],
                fullParameters: { url: "https://x", options: { timeout: 30 } },
              },
            ],
          }),
        }),
      ],
    };
    const html = formatDiffHtml(report);
    expect(html).toContain('class="dline ctx">parameters.url</div>');
    expect(html).toContain('class="dline added">+ https://x</div>');
    expect(html).toContain('class="dline ctx">parameters.options.timeout</div>');
    expect(html).toContain('class="dline added">+ 30</div>');
    // No "- old" rows: the whole node is an addition.
    expect(html).not.toContain("- https://x");
  });
});

describe("formatDiffHtml — raw JSON diff", () => {
  test("renders changed JSON lines when raw workflows are attached", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison()],
    };
    const c = report.comparisons[0]!;
    Object.defineProperties(c, {
      leftRaw: {
        value: { name: "Nightly sync", active: true, nodes: [{ id: "a" }] },
        enumerable: false,
      },
      rightRaw: {
        value: { name: "Nightly sync", active: false, nodes: [{ id: "a" }] },
        enumerable: false,
      },
    });

    const html = formatDiffHtml(report);
    expect(html).toContain("Raw JSON diff");
    expect(html).toContain('class="dline removed"');
    expect(html).toContain("&quot;active&quot;: true");
    expect(html).toContain("&quot;active&quot;: false");
    expect(html).toContain("+1 \u22121");
  });

  test("omits the section when raw workflows are absent", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison()],
    };
    expect(formatDiffHtml(report)).not.toContain("Raw JSON diff");
  });

  test("raw workflows do not leak into JSON.stringify output", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison()],
    };
    const c = report.comparisons[0]!;
    Object.defineProperty(c, "leftRaw", { value: { secret: true }, enumerable: false });
    expect(JSON.parse(JSON.stringify(c))).not.toHaveProperty("leftRaw");
  });
});

describe("formatDiffHtml — raw JSON diff edge cases", () => {
  test("oversized JSON shows a hint instead of the diff", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison()],
    };
    const c = report.comparisons[0]!;
    const big = { name: "w", nodes: Array.from({ length: 4000 }, (_, i) => ({ id: `n${i}` })) };
    Object.defineProperties(c, {
      leftRaw: { value: big, enumerable: false },
      rightRaw: { value: { ...big, name: "w2" }, enumerable: false },
    });

    const html = formatDiffHtml(report);
    expect(html).toContain("exceeds 5000 lines");
  });

  test("identical JSON documents say so", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison()],
    };
    const c = report.comparisons[0]!;
    const same = { name: "w", active: true };
    Object.defineProperties(c, {
      leftRaw: { value: same, enumerable: false },
      rightRaw: { value: { ...same }, enumerable: false },
    });

    expect(formatDiffHtml(report)).toContain("JSON documents are identical");
  });

  test("key order differences do not appear in the raw diff", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [comparison()],
    };
    const c = report.comparisons[0]!;
    Object.defineProperties(c, {
      leftRaw: { value: { a: 1, b: 2 }, enumerable: false },
      rightRaw: { value: { b: 2, a: 1 }, enumerable: false },
    });

    const html = formatDiffHtml(report);
    expect(html).toContain("JSON documents are identical");
  });

  test("added/removed workflows render with their side source", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({ status: "removed", detail: undefined, leftSource: "old.json" }),
        comparison({ status: "added", name: "New one", detail: undefined, rightSource: "server" }),
      ],
    };
    const html = formatDiffHtml(report);
    expect(html).toContain("removed on old.json side");
    expect(html).toContain("added on server side");
  });

  test("added node parameters are embedded in the panel data", () => {
    const report: DiffReport = {
      hasChanges: true,
      comparisons: [
        comparison({
          detail: detail({
            nodeDiffs: [
              {
                kind: "added",
                name: "New HTTP",
                type: "n8n-nodes-base.httpRequest",
                parameterChanges: [],
                otherChanges: [],
                fullParameters: { url: "https://x" },
              },
            ],
          }),
        }),
      ],
    };
    const html = formatDiffHtml(report);
    // The embedded diff-data must carry the synthesized parameter changes so
    // clicking the node in the diagram shows the full parameter diff.
    expect(html).toContain('{"path":"parameters.url","newValue":"https://x"}');
  });
});
