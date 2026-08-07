import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { Scanner } from "@/apply/scanner.ts";
import { defaultApplyOptions } from "@/apply/types.ts";
import { generateTsWorkflow } from "@/ts/generator.ts";
import { loadTsWorkflow } from "@/ts/loader.ts";

const tmpBase = path.join(import.meta.dirname, "__tmp_mixed_formats__");

function workflow(id: string, name: string): Workflow {
  return {
    id,
    name,
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
    ],
    connections: {},
  };
}

function write(dir: string, filename: string, contents: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function writeTs(dir: string, filename: string, wf: Workflow): string {
  return write(dir, filename, generateTsWorkflow(wf));
}

function writeJson(dir: string, filename: string, wf: Workflow): string {
  return write(dir, filename, JSON.stringify(wf, null, 2));
}

function writeYaml(dir: string, filename: string, wf: Workflow): string {
  const yaml = require("js-yaml") as typeof import("js-yaml");
  return write(dir, filename, yaml.dump(wf));
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(`${tmpBase}-`);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanning a directory with json, yaml and ts side by side", () => {
  test("picks up all three when both formats are enabled", async () => {
    writeJson(dir, "a.json", workflow("wf-a", "A"));
    writeYaml(dir, "b.yaml", workflow("wf-b", "B"));
    writeTs(dir, "c.ts", workflow("wf-c", "C"));

    const files = await new Scanner().scanDirectory(dir, true, true);

    expect(files.filter((f) => f.error).map((f) => f.error?.message)).toEqual([]);
    expect(files.map((f) => f.sourceType).sort()).toEqual(["json", "ts", "yaml"]);
    expect(files.map((f) => f.workflow?.id).sort()).toEqual(["wf-a", "wf-b", "wf-c"]);
  });

  test("ignores .ts entirely when ts mode is off", async () => {
    writeJson(dir, "a.json", workflow("wf-a", "A"));
    writeTs(dir, "c.ts", workflow("wf-c", "C"));

    const files = await new Scanner().scanDirectory(dir, true, false);

    expect(files.map((f) => f.sourceType)).toEqual(["json"]);
  });

  test("skips .d.ts declaration files", async () => {
    write(dir, "types.d.ts", "export type Foo = string;\n");
    writeTs(dir, "c.ts", workflow("wf-c", "C"));

    const files = await new Scanner().scanDirectory(dir, true, true);

    expect(files).toHaveLength(1);
    expect(files[0]?.workflow?.id).toBe("wf-c");
  });

  test("rejects the same workflow ID appearing in two formats", async () => {
    writeJson(dir, "dup.json", workflow("wf-dup", "Dup"));
    writeTs(dir, "dup.ts", workflow("wf-dup", "Dup"));

    const opts = {
      ...defaultApplyOptions(),
      directory: dir,
      yamlEnabled: true,
      tsEnabled: true,
      all: true,
    };

    await expect(new Scanner().scanWithOptions(opts)).rejects.toThrow(/duplicate workflow ID/);
  });

  test("reports a broken .ts as a per-file error, leaving the others usable", async () => {
    writeJson(dir, "good.json", workflow("wf-good", "Good"));
    write(dir, "broken.ts", "const a = (((;\n");

    const files = await new Scanner().scanDirectory(dir, true, true);
    const broken = files.find((f) => f.path.endsWith("broken.ts"));
    const good = files.find((f) => f.path.endsWith("good.json"));

    expect(broken?.error).toBeDefined();
    expect(good?.error).toBeUndefined();
    expect(good?.workflow?.id).toBe("wf-good");
  });

  test("a non-workflow .ts file is an error, not a silent skip", async () => {
    // Anything with a .ts extension in the definitions directory is claimed by
    // the scanner once ts mode is on; failing loudly beats applying nothing.
    write(dir, "helpers.ts", "export const add = (a: number, b: number) => a + b;\n");

    const files = await new Scanner().scanDirectory(dir, true, true);

    expect(files).toHaveLength(1);
    expect(files[0]?.error).toBeDefined();
  });
});

describe("loadTsWorkflow", () => {
  test("falls back to the ID encoded in the filename", () => {
    const wf = workflow("", "Named");
    const filePath = writeTs(dir, "named__wf-from-filename.ts", wf);

    expect(loadTsWorkflow(filePath).id).toBe("wf-from-filename");
  });

  test("reuses node IDs from an existing workflow", () => {
    const wf = workflow("wf-x", "X");
    const filePath = writeTs(dir, "x.ts", wf);

    const loaded = loadTsWorkflow(filePath, { existing: wf });

    expect(loaded.nodes[0]?.id).toBe("n1");
  });

  test("wraps failures with the file path", () => {
    const filePath = write(dir, "bad.ts", "const a = (((;\n");

    expect(() => loadTsWorkflow(filePath)).toThrow(/bad\.ts/);
  });
});
