import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "../../src/api/types.ts";
import { buildReport } from "../../src/diff/report.ts";
import { loadWorkflowContent, loadWorkflowFile, pairWorkflows } from "../../src/diff/sources.ts";

function writeTempFile(content: string, ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-test-"));
  const p = path.join(dir, `wf${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

const JSON_WF = JSON.stringify({
  id: "abc",
  name: "From export",
  active: false,
  nodes: [
    {
      id: "n1",
      name: "Start",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: "n2",
      name: "HTTP",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: [200, 0],
      parameters: { url: "https://a" },
    },
  ],
  connections: { Start: { main: [[{ node: "HTTP", type: "main", index: 0 }]] } },
});

describe("loadWorkflowContent / loadWorkflowFile — json", () => {
  test("parses server exports", () => {
    const wf = loadWorkflowContent(JSON_WF, "wf.json");
    expect(wf.id).toBe("abc");
    expect(wf.nodes).toHaveLength(2);
  });

  test("loads from disk identically", () => {
    const p = writeTempFile(JSON_WF, ".json");
    expect(loadWorkflowFile(p).name).toBe("From export");
  });

  test("rejects unknown extensions", () => {
    expect(() => loadWorkflowContent("{}", "wf.txt")).toThrow(/unsupported/);
  });
});

describe("pairWorkflows", () => {
  const wf = (id?: string, name = "w"): Workflow => ({
    ...(id ? { id } : {}),
    name,
    active: false,
    nodes: [],
    connections: {},
  });

  test("pairs by workflow ID first", () => {
    const pairs = pairWorkflows(
      [{ workflow: wf("1"), source: "a.json" }],
      [{ workflow: wf("1"), source: "server" }],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.left?.source).toBe("a.json");
    expect(pairs[0]?.right?.workflow?.id).toBe("1");
  });

  test("falls back to exact name when IDs are missing", () => {
    const pairs = pairWorkflows(
      [{ workflow: wf(undefined, "Hand written") }],
      [{ workflow: wf(undefined, "Hand written") }, { workflow: wf("9", "Other") }],
    );
    expect(pairs).toHaveLength(2);
    const paired = pairs.find((p) => p.left && p.right);
    expect(paired?.right?.workflow?.name).toBe("Hand written");
  });

  test("unpaired entries surface as left-only / right-only", () => {
    const pairs = pairWorkflows([{ workflow: wf("1") }], [{ workflow: wf("2") }]);
    expect(pairs.filter((p) => p.left && !p.right)).toHaveLength(1);
    expect(pairs.filter((p) => p.right && !p.left)).toHaveLength(1);
  });
});

describe("buildReport", () => {
  test("statuses and change detection across a mixed set", () => {
    const oldWf: Workflow = JSON.parse(JSON_WF);
    const changedWf: Workflow = JSON.parse(JSON_WF);
    (changedWf.nodes[1]!.parameters as Record<string, unknown>).url = "https://b";
    changedWf.name = "Renamed workflow";

    const newWf: Workflow = {
      id: "new",
      name: "Brand new",
      active: false,
      nodes: [],
      connections: {},
    };

    const report = buildReport(
      [{ workflow: oldWf }, { workflow: newWf }],
      [{ workflow: changedWf }],
    );

    const byName = new Map(report.comparisons.map((c) => [c.name, c]));
    // Paired via shared ID; the rename shows up in metadata changes.
    const modified = byName.get("Renamed workflow")!;
    expect(modified.status).toBe("modified");
    expect(modified.detail!.metadataChanges.map((c) => c.path)).toContain("name");
    expect(modified.detail!.nodeDiffs[0]!.parameterChanges[0]!.path).toBe("parameters.url");

    expect(byName.get("Brand new")!.status).toBe("removed");

    expect(report.hasChanges).toBe(true);
  });

  test("identical sets report no changes", () => {
    const wf: Workflow = JSON.parse(JSON_WF);
    const report = buildReport([{ workflow: wf }], [{ workflow: structuredClone(wf) }]);
    expect(report.hasChanges).toBe(false);
    expect(report.comparisons[0]!.status).toBe("unchanged");
  });
});

describe("loadWorkflowContent — yaml via temp mirror", () => {
  test("self-contained YAML loads from in-memory content", () => {
    const yaml = `
id: yaml-wf-1
name: YAML workflow
active: false
nodes:
  - id: n1
    name: Start
    type: n8n-nodes-base.manualTrigger
    typeVersion: 1
    position: [0, 0]
    parameters: {}
connections: {}
`;
    const wf = loadWorkflowContent(yaml, "wf.yaml");
    expect(wf.name).toBe("YAML workflow");
    expect(wf.nodes).toHaveLength(1);
  });

  test("malformed YAML surfaces a clear error", () => {
    expect(() => loadWorkflowContent(":::: not yaml :::", "wf.yaml")).toThrow();
  });
});

describe("buildReport — raw workflow attachment", () => {
  test("raws are attached for in-process renderers but excluded from JSON", () => {
    const left: Workflow = { id: "1", name: "A", active: false, nodes: [], connections: {} };
    const right: Workflow = { id: "1", name: "B", active: false, nodes: [], connections: {} };
    const report = buildReport([{ workflow: left }], [{ workflow: right }]);
    const c = report.comparisons[0]!;

    // In-process access works.
    expect(c.leftRaw).toBe(left);
    expect(c.rightRaw).toBe(right);

    // JSON output stays compact.
    const json = JSON.parse(JSON.stringify(c));
    expect(json).not.toHaveProperty("leftRaw");
    expect(json).not.toHaveProperty("rightRaw");
  });

  test("one-sided comparisons carry only their own raw", () => {
    const local: Workflow = { id: "new", name: "New", active: false, nodes: [], connections: {} };
    const report = buildReport([{ workflow: local }], []);
    const c = report.comparisons[0]!;
    expect(c.status).toBe("removed");
    expect(c.leftRaw).toBe(local);
    expect(c.rightRaw).toBeUndefined();
    expect(JSON.parse(JSON.stringify(c))).not.toHaveProperty("leftRaw");
  });
});
