import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { patchTsStamp, patchYamlStamp, updateLocalWorkflowFile } from "@/apply/local-file.ts";
import { loadYamlWorkflow } from "@/yaml/loader.ts";

/**
 * Re-stamping local definitions after a successful write.
 *
 * The stamp is what apply's conflict detection compares against, so the tests
 * that matter are the ones proving it survives a round trip as a *string* and
 * that the surrounding authored file is left alone.
 */

const STAMP = "2026-03-01T10:00:00.000Z";

function workflow(updatedAt?: string): Workflow {
  return {
    id: "wf1",
    name: "example",
    active: false,
    nodes: [],
    connections: {},
    ...(updatedAt ? { updatedAt } : {}),
  } as Workflow;
}

describe("patchYamlStamp", () => {
  test("replaces an existing top-level stamp", () => {
    const out = patchYamlStamp("id: wf1\nname: x\nupdatedAt: '2020-01-01T00:00:00.000Z'\n", STAMP);
    expect(out).toBe(`id: wf1\nname: x\nupdatedAt: '${STAMP}'\n`);
  });

  test("inserts after active when no stamp is present", () => {
    const out = patchYamlStamp("id: wf1\nname: x\nactive: false\nnodes: []\n", STAMP);
    expect(out).toBe(`id: wf1\nname: x\nactive: false\nupdatedAt: '${STAMP}'\nnodes: []\n`);
  });

  test("falls back to name, then id, when the better anchors are missing", () => {
    expect(patchYamlStamp("name: x\nnodes: []\n", STAMP)).toBe(
      `name: x\nupdatedAt: '${STAMP}'\nnodes: []\n`,
    );
    expect(patchYamlStamp("id: wf1\nnodes: []\n", STAMP)).toBe(
      `id: wf1\nupdatedAt: '${STAMP}'\nnodes: []\n`,
    );
  });

  test("leaves an unrecognised document alone", () => {
    expect(patchYamlStamp("nodes: []\n", STAMP)).toBeNull();
  });

  test("does nothing when there is no stamp to write", () => {
    expect(patchYamlStamp("id: wf1\n", undefined)).toBeNull();
  });

  test("only touches the top-level key, not a nested one", () => {
    const text = "id: wf1\nactive: false\nnodes:\n  - name: n\n    updatedAt: nested\n";
    const out = patchYamlStamp(text, STAMP);
    expect(out).toContain("    updatedAt: nested");
    expect(out).toContain(`updatedAt: '${STAMP}'`);
  });
});

describe("patchTsStamp", () => {
  const meta =
    'export const meta = {\n  active: true,\n  updatedAt: "2020-01-01T00:00:00.000Z",\n};\n';

  test("replaces the stamp inside the meta export", () => {
    const out = patchTsStamp(meta, STAMP);
    expect(out).toBe(`export const meta = {\n  active: true,\n  updatedAt: "${STAMP}",\n};\n`);
  });

  test("inserts a stamp into a meta block that has none", () => {
    const out = patchTsStamp("export const meta = {\n  active: true,\n};\n", STAMP);
    expect(out).toBe(`export const meta = {\n  updatedAt: "${STAMP}",\n  active: true,\n};\n`);
  });

  test("leaves a file with no meta export alone", () => {
    expect(patchTsStamp("export const x = 1;\n", STAMP)).toBeNull();
  });
});

describe("updateLocalWorkflowFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-stamp-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("YAML: the stamp reads back as a string, not a Date", async () => {
    const file = path.join(dir, "wf.yaml");
    fs.writeFileSync(file, "id: wf1\nname: example\nactive: false\nnodes: []\nconnections: {}\n");

    await updateLocalWorkflowFile(file, workflow(STAMP));

    const reloaded = loadYamlWorkflow(file);
    expect(reloaded.updatedAt).toBe(STAMP);
    expect(typeof reloaded.updatedAt).toBe("string");
  });

  test("YAML: comments and !include refs survive", async () => {
    const file = path.join(dir, "wf.yaml");
    const original = [
      "# hand-written header",
      "id: wf1",
      "name: example",
      "active: false",
      "nodes:",
      "  - name: n",
      "    parameters:",
      "      jsCode: !include _subfiles/wf__wf1/n.js",
      "",
    ].join("\n");
    fs.writeFileSync(file, original);

    await updateLocalWorkflowFile(file, workflow(STAMP));

    const text = fs.readFileSync(file, "utf-8");
    expect(text).toContain("# hand-written header");
    expect(text).toContain("!include _subfiles/wf__wf1/n.js");
    expect(text).toContain(`updatedAt: '${STAMP}'`);
  });

  test("JSON: identity and both timestamps are written back", async () => {
    const file = path.join(dir, "wf.json");
    fs.writeFileSync(file, JSON.stringify({ id: "old", name: "old", active: true }));

    await updateLocalWorkflowFile(file, {
      ...workflow(STAMP),
      createdAt: "2026-01-01T00:00:00.000Z",
    } as Workflow);

    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(parsed.id).toBe("wf1");
    expect(parsed.name).toBe("example");
    expect(parsed.active).toBe(false);
    expect(parsed.updatedAt).toBe(STAMP);
    expect(parsed.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("an unreadable file is not an error", async () => {
    await updateLocalWorkflowFile(path.join(dir, "missing.yaml"), workflow(STAMP));
  });

  test("a format with no stamping rule is left untouched", async () => {
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "# notes\n");
    await updateLocalWorkflowFile(file, workflow(STAMP));
    expect(fs.readFileSync(file, "utf-8")).toBe("# notes\n");
  });
});
