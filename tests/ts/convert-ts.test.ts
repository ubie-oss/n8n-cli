import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { convertWorkflowFile, detectFormat } from "@/convert/converter.ts";
import { parseWorkflowFile } from "@/importer/scanner.ts";
import { writeWorkflowTS } from "@/importer/writer.ts";

const tmpBase = path.join(import.meta.dirname, "__tmp_convert_ts__");

function workflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "wf-200",
    name: "Convert Me",
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

describe("detectFormat", () => {
  test("recognises .ts", () => {
    expect(detectFormat("a.ts")).toBe("ts");
    expect(detectFormat("a.JSON")).toBe("json");
    expect(detectFormat("a.yml")).toBe("yaml");
    expect(detectFormat("a.txt")).toBeNull();
  });
});

describe("convert JSON → TS", () => {
  test("writes a .ts file that parses back to the same workflow", () => {
    const wf = workflow();
    const source = path.join(dir, "in.json");
    fs.writeFileSync(source, JSON.stringify(wf, null, 2));

    const result = convertWorkflowFile(source, {
      targetFormat: "ts",
      directory: dir,
      externalizeThreshold: 0,
      dryRun: false,
      keepOriginal: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.outputPath.endsWith(".ts")).toBe(true);

    const reparsed = parseWorkflowFile(result.outputPath);
    expect(reparsed.name).toBe(wf.name);
    expect(reparsed.id).toBe(wf.id);
    expect(reparsed.nodes.map((n) => n.name)).toEqual(["Trigger", "Set"]);
  });

  test("removes the original unless --keep is set", () => {
    const source = path.join(dir, "in.json");
    fs.writeFileSync(source, JSON.stringify(workflow(), null, 2));

    convertWorkflowFile(source, {
      targetFormat: "ts",
      directory: dir,
      externalizeThreshold: 0,
      dryRun: false,
      keepOriginal: false,
    });

    expect(fs.existsSync(source)).toBe(false);
  });

  test("is a no-op when the source is already .ts", () => {
    const source = path.join(dir, "in.ts");
    writeWorkflowTS(source, workflow());

    const result = convertWorkflowFile(source, {
      targetFormat: "ts",
      directory: dir,
      externalizeThreshold: 0,
      dryRun: false,
      keepOriginal: true,
    });

    expect(result.skipped).toBe(true);
  });
});

describe("convert TS → JSON", () => {
  test("round-trips back through JSON", () => {
    const tsPath = path.join(dir, "in.ts");
    writeWorkflowTS(tsPath, workflow());

    const result = convertWorkflowFile(tsPath, {
      targetFormat: "json",
      directory: dir,
      externalizeThreshold: 0,
      dryRun: false,
      keepOriginal: true,
    });

    expect(result.error).toBeUndefined();
    const json = JSON.parse(fs.readFileSync(result.outputPath, "utf-8")) as Workflow;
    expect(json.name).toBe("Convert Me");
    expect(json.nodes).toHaveLength(2);
  });
});

describe("writeWorkflowTS", () => {
  test("refuses to write a workflow it cannot represent faithfully", () => {
    // A connection pointing at a node that does not exist cannot survive the
    // builder graph, so the round-trip check must catch it.
    const broken = workflow({
      connections: {
        Trigger: { main: [[{ node: "Missing", type: "main", index: 0 }]] },
      },
    });

    expect(() => writeWorkflowTS(path.join(dir, "broken.ts"), broken)).toThrow();
    expect(fs.existsSync(path.join(dir, "broken.ts"))).toBe(false);
  });

  test("writes atomically — no .tmp file left behind", () => {
    writeWorkflowTS(path.join(dir, "ok.ts"), workflow());

    expect(fs.readdirSync(dir)).toEqual(["ok.ts"]);
  });
});
