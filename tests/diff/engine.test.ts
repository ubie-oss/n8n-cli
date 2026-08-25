import { describe, expect, test } from "bun:test";
import type { Node, Workflow } from "../../src/api/types.ts";
import { compareWorkflows, diffLines, isDetailEmpty } from "../../src/diff/engine.ts";

function node(overrides: Partial<Node> & { name: string; type: string }): Node {
  return {
    id: overrides.name.toLowerCase().replaceAll(" ", "-"),
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
    ...overrides,
  } as Node;
}

function workflow(
  nodes: Node[],
  connections: Workflow["connections"] = {},
  extra: Partial<Workflow> = {},
): Workflow {
  return {
    name: "test workflow",
    active: false,
    nodes,
    connections,
    ...extra,
  };
}

const HTTP_TYPE = "n8n-nodes-base.httpRequest";
const SET_TYPE = "n8n-nodes-base.set";
const CODE_TYPE = "n8n-nodes-base.code";

function baseNodes(): Node[] {
  return [
    node({ name: "Trigger", type: "n8n-nodes-base.manualTrigger" }),
    node({ name: "HTTP Request", type: HTTP_TYPE, parameters: { url: "https://api.example.com" } }),
    node({
      name: "Code",
      type: CODE_TYPE,
      parameters: { jsCode: "const a = 1;\nreturn a;" },
    }),
  ];
}

describe("compareWorkflows — unchanged", () => {
  test("identical workflows produce an empty detail with full context", () => {
    const wf = workflow(baseNodes(), {
      Trigger: { main: [[{ node: "HTTP Request", type: "main", index: 0 }]] },
    });
    const detail = compareWorkflows(wf, structuredClone(wf));
    expect(isDetailEmpty(detail)).toBe(true);
    // Rendering context: everything is unchanged, and it is all reported.
    // Order follows the input node order.
    expect(detail.unchangedNodes.map((n) => n.name)).toEqual(["Trigger", "HTTP Request", "Code"]);
    expect(detail.unchangedEdges).toEqual([
      {
        source: "Trigger",
        target: "HTTP Request",
        connectionType: "main",
        sourceOutputIndex: 0,
        targetInputIndex: 0,
      },
    ]);
  });

  test("key order and nil-vs-missing do not matter", () => {
    const a = workflow([node({ name: "A", type: SET_TYPE, parameters: {} })]);
    const b = workflow([node({ name: "A", type: SET_TYPE })]);
    expect(isDetailEmpty(compareWorkflows(a, b))).toBe(true);
  });
});

describe("compareWorkflows — runtime noise", () => {
  test("position changes are ignored by default", () => {
    const oldWf = workflow(baseNodes());
    const newWf = structuredClone(oldWf);
    newWf.nodes[1]!.position = [400, 300];
    expect(isDetailEmpty(compareWorkflows(oldWf, newWf))).toBe(true);
  });

  test("position changes are reported with includePosition", () => {
    const oldWf = workflow(baseNodes());
    const newWf = structuredClone(oldWf);
    newWf.nodes[1]!.position = [400, 300];
    const detail = compareWorkflows(oldWf, newWf, { includePosition: true });
    const moved = detail.nodeDiffs.find((d) => d.kind === "modified");
    expect(moved?.otherChanges.some((c) => c.path === "position")).toBe(true);
  });

  test("staticData drift is always ignored", () => {
    const oldWf = workflow(baseNodes());
    const newWf = structuredClone(oldWf);
    newWf.staticData = { "node:Trigger": { context: { x: 1 } } };
    expect(isDetailEmpty(compareWorkflows(oldWf, newWf))).toBe(true);
  });

  test("pinData changes are summarized as counts", () => {
    const oldWf = workflow(baseNodes());
    const newWf = structuredClone(oldWf);
    newWf.pinData = { Code: [{ json: { big: "data" } }] };
    const detail = compareWorkflows(oldWf, newWf);
    expect(detail.pinDataChanges).toEqual([
      { path: "pinData", oldValue: "0 nodes", newValue: "1 nodes" },
    ]);
  });
});

describe("compareWorkflows — nodes", () => {
  test("added and removed nodes are detected by ID", () => {
    const oldWf = workflow(baseNodes());
    const newWf = workflow([...baseNodes(), node({ name: "Slack", type: "n8n-nodes-base.slack" })]);
    newWf.nodes.splice(1, 1); // drop HTTP Request

    const detail = compareWorkflows(oldWf, newWf);
    const kinds = detail.nodeDiffs.map((d) => `${d.kind}:${d.name}`).sort();
    expect(kinds).toEqual(["added:Slack", "removed:HTTP Request"]);
  });

  test("parameter changes report concrete paths", () => {
    const oldWf = workflow(baseNodes());
    const newWf = structuredClone(oldWf);
    (newWf.nodes[1]!.parameters as Record<string, unknown>).url = "https://api2.example.com";
    (newWf.nodes[1]!.parameters as Record<string, unknown>).headers = { "X-Test": "yes" };

    const detail = compareWorkflows(oldWf, newWf);
    const modified = detail.nodeDiffs.find((d) => d.kind === "modified")!;
    const paths = modified.parameterChanges.map((c) => c.path);
    expect(paths).toContain("parameters.url");
    expect(paths).toContain("parameters.headers.X-Test");
  });

  test("renamed node with same content is 'renamed' (TS-style ID churn)", () => {
    const oldWf = workflow([
      // Simulates ts/node-ids.ts: ID derives from the name, so a rename
      // changes both. Only type + parameters survive.
      node({
        name: "Fetch Data",
        id: "id-from-fetch-data",
        type: HTTP_TYPE,
        parameters: { url: "https://x" },
      }),
    ]);
    const newWf = workflow([
      node({
        name: "Fetch Users",
        id: "id-from-fetch-users",
        type: HTTP_TYPE,
        parameters: { url: "https://x" },
      }),
    ]);

    const detail = compareWorkflows(oldWf, newWf);
    expect(detail.nodeDiffs).toHaveLength(1);
    expect(detail.nodeDiffs[0]!.kind).toBe("renamed");
    expect(detail.nodeDiffs[0]!.oldName).toBe("Fetch Data");
    expect(detail.nodeDiffs[0]!.name).toBe("Fetch Users");
  });

  test("rename plus parameter change is 'modified' with the old name attached", () => {
    const oldWf = workflow([
      node({ name: "Fetch Data", id: "a", type: HTTP_TYPE, parameters: { url: "https://x" } }),
    ]);
    const newWf = workflow([
      node({ name: "Fetch Users", id: "b", type: HTTP_TYPE, parameters: { url: "https://y" } }),
    ]);

    const detail = compareWorkflows(oldWf, newWf);
    const nd = detail.nodeDiffs[0]!;
    expect(nd.kind).toBe("modified");
    expect(nd.oldName).toBe("Fetch Data");
    expect(nd.parameterChanges.map((c) => c.path)).toContain("parameters.url");
  });

  test("code parameters get line-level diffs instead of value dumps", () => {
    const oldWf = workflow(baseNodes());
    const newWf = structuredClone(oldWf);
    newWf.nodes[2]!.parameters = { jsCode: "const a = 2;\nreturn a;" };

    const detail = compareWorkflows(oldWf, newWf);
    const modified = detail.nodeDiffs.find((d) => d.kind === "modified")!;
    const change = modified.parameterChanges.find((c) => c.path === "parameters.jsCode")!;
    expect(change.lineChanges).toEqual([
      { kind: "removed", lineNumber: 1, text: "const a = 1;" },
      { kind: "added", lineNumber: 1, text: "const a = 2;" },
    ]);
  });

  test("credential reference changes are reported without values leaking concerns", () => {
    const oldWf = workflow([
      node({
        name: "HTTP",
        type: HTTP_TYPE,
        credentials: { httpBasicAuth: { id: "1", name: "old" } },
      }),
    ]);
    const newWf = workflow([
      node({
        name: "HTTP",
        type: HTTP_TYPE,
        credentials: { httpBasicAuth: { id: "2", name: "new" } },
      }),
    ]);

    const detail = compareWorkflows(oldWf, newWf);
    const nd = detail.nodeDiffs[0]!;
    const credChange = nd.otherChanges.find((c) => c.path.startsWith("credentials."));
    expect(credChange).toBeDefined();
  });

  test("typeVersion bumps are reported", () => {
    const oldWf = workflow([node({ name: "Set", type: SET_TYPE, typeVersion: 3 })]);
    const newWf = workflow([node({ name: "Set", type: SET_TYPE, typeVersion: 4 })]);
    const nd = compareWorkflows(oldWf, newWf).nodeDiffs[0]!;
    expect(nd.otherChanges.some((c) => c.path === "typeVersion")).toBe(true);
  });
});

describe("compareWorkflows — connections", () => {
  test("rewiring is reported per edge, not as one boolean", () => {
    const conn = (target: string) => ({ main: [[{ node: target, type: "main", index: 0 }]] });
    const oldWf = workflow(
      [
        node({ name: "A", type: SET_TYPE }),
        node({ name: "B", type: HTTP_TYPE }),
        node({ name: "C", type: CODE_TYPE }),
      ],
      { A: conn("B") },
    );
    const newWf = structuredClone(oldWf);
    newWf.connections = { A: conn("C"), B: conn("C") };

    const detail = compareWorkflows(oldWf, newWf);
    const edges = detail.edgeDiffs.map((e) => `${e.kind} ${e.source}->${e.target}`);
    expect(edges.sort()).toEqual(["added A->C", "added B->C", "removed A->B"]);
  });

  test("a rename does not masquerade as rewiring when IDs change", () => {
    const conn = (target: string) => ({ main: [[{ node: target, type: "main", index: 0 }]] });
    const oldWf = workflow(
      [
        node({ name: "Start", id: "s1", type: "n8n-nodes-base.manualTrigger" }),
        node({ name: "Old Name", id: "o1", type: HTTP_TYPE, parameters: { url: "u" } }),
      ],
      { Start: conn("Old Name") },
    );
    const newWf = workflow(
      [
        node({ name: "Start", id: "s2", type: "n8n-nodes-base.manualTrigger" }),
        node({ name: "New Name", id: "o2", type: HTTP_TYPE, parameters: { url: "u" } }),
      ],
      { Start: conn("New Name") },
    );

    const detail = compareWorkflows(oldWf, newWf);
    expect(detail.edgeDiffs).toEqual([]);
    expect(detail.nodeDiffs[0]!.kind).toBe("renamed");
  });

  test("ai_* connection types are compared like main edges", () => {
    const oldWf = workflow(
      [
        node({ name: "Agent", type: "@n8n/n8n-nodes-langchain.agent" }),
        node({ name: "Model", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi" }),
      ],
      { Agent: { ai_languageModel: [[{ node: "Model", type: "ai_languageModel", index: 0 }]] } },
    );
    const newWf = structuredClone(oldWf);
    delete newWf.connections.Agent!.ai_languageModel;

    const detail = compareWorkflows(oldWf, newWf);
    expect(detail.edgeDiffs).toEqual([
      {
        kind: "removed",
        source: "Agent",
        target: "Model",
        connectionType: "ai_languageModel",
        sourceOutputIndex: 0,
        targetInputIndex: 0,
      },
    ]);
  });
});

describe("compareWorkflows — metadata and settings", () => {
  test("name/active/description changes land in metadataChanges", () => {
    const oldWf = workflow(baseNodes(), {}, { active: true, description: "old" });
    const newWf = structuredClone(oldWf);
    newWf.active = false;
    newWf.description = "";

    const detail = compareWorkflows(oldWf, newWf);
    const paths = detail.metadataChanges.map((c) => c.path);
    expect(paths).toEqual(["active", "description"]);
  });

  test("missing description equals empty description", () => {
    const oldWf = workflow(baseNodes(), {}, { description: "" });
    const newWf = structuredClone(oldWf);
    delete newWf.description;
    expect(isDetailEmpty(compareWorkflows(oldWf, newWf))).toBe(true);
  });

  test("settings changes report nested paths", () => {
    const oldWf = workflow(baseNodes(), {}, { settings: { timezone: "UTC" } });
    const newWf = workflow(
      baseNodes(),
      {},
      { settings: { timezone: "Asia/Tokyo", executionTimeout: 3600 } },
    );

    const detail = compareWorkflows(oldWf, newWf);
    const paths = detail.settingsChanges.map((c) => c.path);
    expect(paths).toEqual(["settings.executionTimeout", "settings.timezone"]);
  });
});

describe("diffLines", () => {
  test("finds changed lines with correct side numbering", () => {
    const changes = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(changes).toEqual([
      { kind: "removed", lineNumber: 2, text: "b" },
      { kind: "added", lineNumber: 2, text: "B" },
      { kind: "added", lineNumber: 4, text: "d" },
    ]);
  });

  test("identical text yields no changes", () => {
    expect(diffLines("same\nlines", "same\nlines")).toEqual([]);
  });
});

describe("compareWorkflows — full parameters on add/delete", () => {
  test("added nodes carry their complete parameter snapshot", () => {
    const oldWf = workflow([]);
    const newWf = workflow([
      node({
        name: "New HTTP",
        type: HTTP_TYPE,
        parameters: { url: "https://x", options: { timeout: 30 } },
      }),
    ]);

    const detail = compareWorkflows(oldWf, newWf);
    const added = detail.nodeDiffs.find((d) => d.kind === "added")!;
    expect(added.fullParameters).toEqual({ url: "https://x", options: { timeout: 30 } });
    expect(added.parameterChanges).toEqual([]);
  });

  test("removed nodes carry their complete parameter snapshot", () => {
    const oldWf = workflow([
      node({ name: "Old", type: HTTP_TYPE, parameters: { url: "https://old" } }),
    ]);
    const detail = compareWorkflows(oldWf, workflow([]));
    const removed = detail.nodeDiffs.find((d) => d.kind === "removed")!;
    expect(removed.fullParameters).toEqual({ url: "https://old" });
  });

  test("modified nodes do not carry a snapshot", () => {
    const oldWf = workflow([node({ name: "A", type: HTTP_TYPE, parameters: { url: "a" } })]);
    const newWf = workflow([node({ name: "A", type: HTTP_TYPE, parameters: { url: "b" } })]);
    const nd = compareWorkflows(oldWf, newWf).nodeDiffs[0]!;
    expect(nd.fullParameters).toBeUndefined();
  });
});

describe("compareWorkflows — self-review hardening", () => {
  test("scalar node fields (disabled/onError/notes) are compared", () => {
    const oldWf = workflow([
      node({ name: "A", type: HTTP_TYPE, disabled: false, onError: "stopWorkflow" }),
    ]);
    const newWf = workflow([
      node({ name: "A", type: HTTP_TYPE, disabled: true, onError: "continueRegularOutput" }),
    ]);

    const nd = compareWorkflows(oldWf, newWf).nodeDiffs[0]!;
    const paths = nd.otherChanges.map((c) => c.path);
    expect(paths).toContain("disabled");
    expect(paths).toContain("onError");
  });

  test("edges on non-zero output indexes are distinguished", () => {
    const conn = {
      main: [[{ node: "B", type: "main", index: 0 }], [{ node: "C", type: "main", index: 0 }]],
    };
    const oldWf = workflow(
      [
        node({ name: "A", type: "n8n-nodes-base.if" }),
        node({ name: "B", type: SET_TYPE }),
        node({ name: "C", type: SET_TYPE }),
      ],
      { A: conn },
    );
    const newWf = structuredClone(oldWf);
    // Swap the branch targets: output 0 now goes to C, output 1 to B.
    newWf.connections = {
      A: {
        main: [[{ node: "C", type: "main", index: 0 }], [{ node: "B", type: "main", index: 0 }]],
      },
    };

    const detail = compareWorkflows(oldWf, newWf);
    const edges = detail.edgeDiffs
      .map((e) => `${e.kind} out${e.sourceOutputIndex}->${e.target}`)
      .sort();
    expect(edges).toEqual(["added out0->C", "added out1->B", "removed out0->B", "removed out1->C"]);
  });

  test("edges of a removed node are reported as removed", () => {
    const conn = { A: { main: [[{ node: "Doomed", type: "main", index: 0 }]] } };
    const oldWf = workflow(
      [
        node({ name: "A", type: SET_TYPE }),
        node({ name: "Doomed", type: HTTP_TYPE, parameters: { url: "u" } }),
      ],
      conn,
    );
    const newWf = workflow([node({ name: "A", type: SET_TYPE })]);

    const detail = compareWorkflows(oldWf, newWf);
    const removedEdge = detail.edgeDiffs.find((e) => e.kind === "removed")!;
    expect(removedEdge.source).toBe("A");
    expect(removedEdge.target).toBe("Doomed");
    // And a node named with the internal marker prefix must not confuse it.
    expect(removedEdge.target).not.toContain("\u0000");
  });

  test("a node literally named with a marker-like prefix does not break edge diffs", () => {
    const oldWf = workflow(
      [
        node({ name: "A", type: SET_TYPE }),
        node({ name: "gone: A", type: HTTP_TYPE, parameters: { url: "u" } }),
      ],
      { A: { main: [[{ node: "gone: A", type: "main", index: 0 }]] } },
    );
    const newWf = workflow([node({ name: "A", type: SET_TYPE })]);

    const detail = compareWorkflows(oldWf, newWf);
    const removedEdge = detail.edgeDiffs.find((e) => e.kind === "removed")!;
    expect(removedEdge.target).toBe("gone: A");
  });

  test("code parameters above the line-diff size cap fall back to value dumps", () => {
    const bigOld = Array.from({ length: 1200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const bigNew = `${bigOld}\nconst extra = 1;`;
    const oldWf = workflow([node({ name: "C", type: CODE_TYPE, parameters: { jsCode: bigOld } })]);
    const newWf = workflow([node({ name: "C", type: CODE_TYPE, parameters: { jsCode: bigNew } })]);

    const change = compareWorkflows(oldWf, newWf).nodeDiffs[0]!.parameterChanges[0]!;
    expect(change.lineChanges).toBeUndefined();
    expect(change.oldValue).toBe(bigOld);
    expect(change.newValue).toBe(bigNew);
  });

  test("a code-keyed parameter that stops being a string falls back to a value dump", () => {
    const oldWf = workflow([
      node({ name: "C", type: CODE_TYPE, parameters: { jsCode: "return 1;" } }),
    ]);
    // null normalizes to "absent", so the change is old value -> absent.
    const newWf = workflow([node({ name: "C", type: CODE_TYPE, parameters: { jsCode: null } })]);

    const change = compareWorkflows(oldWf, newWf).nodeDiffs[0]!.parameterChanges[0]!;
    expect(change.lineChanges).toBeUndefined();
    expect(change.oldValue).toBe("return 1;");
    expect(change.newValue).toBeUndefined();
  });

  test("pass 4 pairs multiple simultaneous same-type renames", () => {
    const oldWf = workflow([
      node({ name: "Fetch A", id: "fa", type: HTTP_TYPE, parameters: { url: "https://a" } }),
      node({ name: "Fetch B", id: "fb", type: HTTP_TYPE, parameters: { url: "https://b" } }),
    ]);
    const newWf = workflow([
      node({ name: "Load Users", id: "fa2", type: HTTP_TYPE, parameters: { url: "https://a/v2" } }),
      node({
        name: "Load Orders",
        id: "fb2",
        type: HTTP_TYPE,
        parameters: { url: "https://b/v2" },
      }),
    ]);

    const detail = compareWorkflows(oldWf, newWf);
    const kinds = detail.nodeDiffs.map((d) => d.kind).sort();
    expect(kinds).toEqual(["modified", "modified"]);
    const oldNames = detail.nodeDiffs.map((d) => d.oldName).sort();
    expect(oldNames).toEqual(["Fetch A", "Fetch B"]);
  });
});
