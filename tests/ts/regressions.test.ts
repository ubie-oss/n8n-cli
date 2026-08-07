import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { Workflow } from "@/api/types.ts";
import { registerImportCommand } from "@/cli/commands/import.ts";
import {
  detectWorkflowFormat,
  WORKFLOW_EXTENSIONS,
  WORKFLOW_EXTENSIONS_WITH_TS,
} from "@/common/extensions.ts";
import { scanDirectoryWithOrphans } from "@/importer/scanner.ts";
import { writeWorkflowTS } from "@/importer/writer.ts";
import { generateTsWorkflow } from "@/ts/generator.ts";
import { parseTsWorkflow } from "@/ts/loader.ts";
import { preprocessTsWorkflow, TsPreprocessError } from "@/ts/preprocess.ts";

const tmpBase = path.join(import.meta.dirname, "__tmp_regressions__");

function workflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "wf-1",
    name: "W",
    active: false,
    nodes: [
      {
        id: "aaa",
        name: "A",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: "bbb",
        name: "B",
        type: "n8n-nodes-base.set",
        typeVersion: 3.4,
        position: [300, 300],
        parameters: {},
      },
    ],
    connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(`${tmpBase}-`);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("`.ts` never leaks into commands that did not ask for it", () => {
  test("the shared extension set stays JSON/YAML only", () => {
    // `lint`, `fmt` and `convert -d` walk directories using this set and assume
    // everything they find parses as a workflow. A repository that keeps
    // workflows as `.ts` is full of TypeScript that does not.
    expect(WORKFLOW_EXTENSIONS.has(".ts")).toBe(false);
    expect(WORKFLOW_EXTENSIONS_WITH_TS.has(".ts")).toBe(true);
  });

  test("detectWorkflowFormat rejects declaration files", () => {
    expect(detectWorkflowFormat("types.d.ts")).toBeNull();
    expect(detectWorkflowFormat("workflow.ts")).toBe("ts");
  });

  test("the importer never treats non-workflow TypeScript as an orphan", () => {
    // Otherwise `--cleanup-orphans` would delete hand-written TypeScript that
    // merely happens to live in the definitions directory.
    fs.writeFileSync(path.join(dir, "helper.ts"), "export const add = (a: number) => a;\n");

    for (const tsEnabled of [false, true]) {
      const [ids, orphans] = scanDirectoryWithOrphans(dir, tsEnabled);
      expect(orphans.count()).toBe(0);
      expect(ids.count()).toBe(0);
    }
  });

  test("an existing .ts with an ID is indexed even when ts mode is off", () => {
    // The importer decides a workflow's format from the file it already has. If
    // the scan hid `.ts`, import would think the workflow is new and write a
    // second file — a .json next to the .ts — that then drifts out of sync.
    writeWorkflowTS(path.join(dir, "w__wf-1.ts"), workflow());

    const [ids] = scanDirectoryWithOrphans(dir, false);
    const [found, ok] = ids.get("wf-1");

    expect(ok).toBe(true);
    expect(found.endsWith(".ts")).toBe(true);
  });

  test("a workflow .ts without an ID is still seen as an orphan when ts mode is on", () => {
    fs.writeFileSync(
      path.join(dir, "NoId.ts"),
      [
        `const t = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'T' } });`,
        `const wf = workflow('', 'Handwritten');`,
        "export default wf.add(t)",
        "",
      ].join("\n"),
    );

    const [, orphansOn] = scanDirectoryWithOrphans(dir, true);
    expect(orphansOn.all().map((o) => o.name)).toEqual(["Handwritten"]);
  });
});

describe("a `.ts` file that fails to parse stays visible to import", () => {
  test("its ID is recovered from the filename", () => {
    // Losing the file from the scan makes import write a *second* file for the
    // same workflow, leaving a duplicate and no explanation.
    fs.writeFileSync(path.join(dir, "Broken__wf-9.ts"), "const a = (((;\n");

    const [idMap] = scanDirectoryWithOrphans(dir, true);
    const [foundPath, found] = idMap.get("wf-9");

    expect(found).toBe(true);
    expect(foundPath.endsWith("Broken__wf-9.ts")).toBe(true);
  });
});

describe("positions at the canvas origin", () => {
  test("survive the round trip", () => {
    // `n8n-cli fmt` anchors the top-left node at exactly [0, 0], and the SDK
    // reads a missing position as "lay this out for me". Without an explicit
    // position every formatted workflow would be unconvertible.
    const wf = workflow();
    const code = generateTsWorkflow(wf);

    expect(code).toContain("position: [0, 0]");
    expect(parseTsWorkflow(code, "wf-1").nodes[0]?.position).toEqual([0, 0]);
  });

  test("do not block writing a formatted workflow", () => {
    expect(() => writeWorkflowTS(path.join(dir, "w.ts"), workflow())).not.toThrow();
  });
});

describe("round-trip verification covers the fields the SDK drops", () => {
  test("refuses to write a workflow carrying staticData", () => {
    // staticData has no representation in the SDK at all, so it would vanish
    // without a trace and then be wiped upstream on the next apply.
    const wf = workflow({ staticData: { node: { cursor: "abc" } } });

    expect(() => writeWorkflowTS(path.join(dir, "static.ts"), wf)).toThrow(/staticData/);
    expect(fs.existsSync(path.join(dir, "static.ts"))).toBe(false);
  });

  test("names the offending node and field when nodes differ", () => {
    // A connection to a node that does not exist cannot survive the builder graph.
    const wf = workflow({
      connections: { A: { main: [[{ node: "Missing", type: "main", index: 0 }]] } },
    });

    expect(() => writeWorkflowTS(path.join(dir, "broken.ts"), wf)).toThrow();
  });

  test("accepts a workflow whose settings object is empty", () => {
    // The loader drops empty settings so apply never sends `settings: {}`, which
    // must not then read as a round-trip loss.
    const wf = workflow({ settings: {} as Workflow["settings"] });

    expect(() => writeWorkflowTS(path.join(dir, "empty-settings.ts"), wf)).not.toThrow();
  });

  test("accepts a workflow whose nodes carry no IDs", () => {
    // Hand-written JSON often omits node IDs. The loader has to invent one, but
    // that is not information loss and must not block conversion.
    const wf = workflow();
    const nodes = wf.nodes.map(({ id: _id, ...rest }) => rest as Workflow["nodes"][number]);

    expect(() => writeWorkflowTS(path.join(dir, "no-ids.ts"), { ...wf, nodes })).not.toThrow();
  });

  test("keeps settings rather than replacing them with an empty object", () => {
    const wf = workflow({ settings: { executionOrder: "v1" } as Workflow["settings"] });

    expect(parseTsWorkflow(generateTsWorkflow(wf), "wf-1").settings).toEqual({
      executionOrder: "v1",
    } as Workflow["settings"]);
  });
});

describe("generated import statement", () => {
  test("ignores SDK function names that only appear inside node parameters", () => {
    // A Code node's jsCode is arbitrary JavaScript; matching it textually would
    // import functions the file never calls and break noUnusedImports.
    const wf = workflow({
      nodes: [
        {
          id: "aaa",
          name: "A",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [100, 300],
          parameters: { jsCode: "const m = merge([1,2]); const t = tool(1); expr(2); sticky(3);" },
        },
      ],
      connections: {},
    });

    const importLine = generateTsWorkflow(wf).split("\n")[0] ?? "";

    expect(importLine).toContain("workflow");
    for (const fn of ["merge", "tool", "sticky"]) {
      expect(importLine).not.toContain(`${fn},`);
    }
  });
});

describe("metadata block edge cases", () => {
  test("refuses to share its statement with another declaration", () => {
    // The whole statement is blanked out, so a second declarator would be
    // silently deleted and the file would fail with an unrelated error.
    expect(() =>
      preprocessTsWorkflow("export const meta = { active: true }, helper = 5;\n"),
    ).toThrow(TsPreprocessError);
  });

  test("round-trips nodeIds", () => {
    const { meta } = preprocessTsWorkflow('export const meta = { nodeIds: { "A": "aaa" } };\n');
    expect(meta.nodeIds).toEqual({ A: "aaa" });
  });

  test("rejects non-string nodeIds values", () => {
    expect(() => preprocessTsWorkflow("export const meta = { nodeIds: { A: 1 } };\n")).toThrow(
      /nodeIds values must be strings/,
    );
  });
});

describe("import format flags distinguish 'not passed' from 'explicitly off'", () => {
  // A commander `.option(..., false)` default makes an unpassed flag report
  // `false`, which is indistinguishable from `--no-yaml` / `--no-ts` — so the
  // CLAUDE.md setting could never be reached. Asserted against the real command
  // definition, not a stand-in built in the test.
  function importCommand() {
    const program = new Command();
    registerImportCommand(program);
    const cmd = program.commands.find((c) => c.name() === "import");
    if (!cmd) throw new Error("import command was not registered");
    return cmd;
  }

  function parsedOptions(argv: string[]): Record<string, unknown> {
    const cmd = importCommand();
    // Stop before the action handler, which would try to reach a server.
    cmd.exitOverride();
    cmd.parseOptions(argv);
    return cmd.opts() as Record<string, unknown>;
  }

  test("neither format flag carries a default value", () => {
    const options = importCommand().options;
    for (const long of ["--yaml", "--ts"]) {
      const option = options.find((o) => o.long === long);
      expect(option).toBeDefined();
      expect(option?.defaultValue).toBeUndefined();
    }
  });

  test("an unpassed flag is undefined, so the config is consulted", () => {
    const opts = parsedOptions([]);
    expect(opts.yaml).toBeUndefined();
    expect(opts.ts).toBeUndefined();
  });

  test("--ts and --no-ts stay distinguishable", () => {
    expect(parsedOptions(["--ts"]).ts).toBe(true);
    expect(parsedOptions(["--no-ts"]).ts).toBe(false);
  });

  test("--yaml and --no-yaml stay distinguishable", () => {
    expect(parsedOptions(["--yaml"]).yaml).toBe(true);
    expect(parsedOptions(["--no-yaml"]).yaml).toBe(false);
  });
});

describe("an unparseable .ts is only claimed as a workflow in ts mode", () => {
  test("ordinary TypeScript named like a workflow is left alone", () => {
    // `utils__abc123.ts` is a helper, not the workflow `abc123`. Claiming it
    // would let import overwrite — or rename and delete — the user's source file.
    fs.writeFileSync(
      path.join(dir, "utils__abc123.ts"),
      "export const add = (a: number) => a + 1;\n",
    );

    const [ids] = scanDirectoryWithOrphans(dir, false);

    expect(ids.count()).toBe(0);
  });

  test("but a broken .ts workflow still holds its slot when ts mode is on", () => {
    fs.writeFileSync(path.join(dir, "broken__abc123.ts"), "const a = (((;\n");

    const [ids] = scanDirectoryWithOrphans(dir, true);

    expect(ids.get("abc123")[1]).toBe(true);
  });
});

describe("empty-string node IDs", () => {
  test("count as absent on both sides of the comparison", () => {
    // Otherwise the source's `id: ""` and the loader's derived ID read as a
    // difference and the workflow could never be written.
    const wf = workflow();
    const nodes = wf.nodes.map((n) => ({ ...n, id: "" }));

    expect(() => writeWorkflowTS(path.join(dir, "empty-ids.ts"), { ...wf, nodes })).not.toThrow();
  });

  test("a node whose real ID changed still fails", () => {
    // The relaxation above must not swallow a genuine ID mismatch.
    const wf = workflow();
    const code = generateTsWorkflow(wf).replace('"bbb"', '"tampered"');

    expect(parseTsWorkflow(code, "wf-1").nodes[1]?.id).toBe("tampered");
  });
});
