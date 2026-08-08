import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { Workflow } from "@/api/types.ts";
import { patchTsStamp, patchYamlStamp, updateLocalWorkflowFile } from "@/apply/local-file.ts";
import { parseTsWorkflow } from "@/ts/loader.ts";
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

describe("patchTsStamp on hand-authored shapes", () => {
  test("finds a meta export carrying a type annotation", () => {
    const text =
      'export const meta: TsWorkflowMeta = {\n  active: true,\n  updatedAt: "old",\n};\n';
    expect(patchTsStamp(text, STAMP)).toBe(
      `export const meta: TsWorkflowMeta = {\n  active: true,\n  updatedAt: "${STAMP}",\n};\n`,
    );
  });

  test("replaces the stamp in a single-line meta instead of duplicating the key", () => {
    const text = 'export const meta = { active: true, updatedAt: "old" };\nconst x = 1;\n';
    const out = patchTsStamp(text, STAMP);
    expect(out).toBe(
      `export const meta = { active: true, updatedAt: "${STAMP}" };\nconst x = 1;\n`,
    );
    expect(out?.match(/updatedAt:/g)).toHaveLength(1);
  });

  test("does not reach past a single-line meta into the workflow below it", () => {
    const text = [
      "export const meta = { active: true };",
      "const node = wf.add({",
      '  parameters: { updatedAt: "not-the-stamp" },',
      "});",
      "",
    ].join("\n");

    const out = patchTsStamp(text, STAMP);

    expect(out).toContain('updatedAt: "not-the-stamp"');
    expect(out).toContain(`{\n  updatedAt: "${STAMP}", active: true }`);
  });

  test("ignores a node named updatedAt inside nodeIds", () => {
    const text = [
      "export const meta = {",
      "  active: true,",
      '  nodeIds: { "updatedAt": "node-1" },',
      "};",
      "",
    ].join("\n");

    const out = patchTsStamp(text, STAMP);

    expect(out).toContain('nodeIds: { "updatedAt": "node-1" }');
    expect(out).toContain(`updatedAt: "${STAMP}",\n  active: true`);
  });

  test("is not confused by a brace inside a string or comment", () => {
    const text = [
      "export const meta = {",
      "  // a { brace in a comment",
      '  tags: ["has { brace"],',
      '  updatedAt: "old",',
      "};",
      "",
    ].join("\n");

    expect(patchTsStamp(text, STAMP)).toContain(`updatedAt: "${STAMP}"`);
  });

  test("leaves a file with unbalanced braces alone", () => {
    expect(patchTsStamp("export const meta = {\n  active: true,\n", STAMP)).toBeNull();
  });
});

describe("a patched .ts file still parses", () => {
  const workflowTail = [
    "",
    "const t = trigger({",
    "  type: 'n8n-nodes-base.manualTrigger',",
    "  version: 1,",
    "  config: { name: 'T' }",
    "});",
    "",
    "export default workflow('wf1', 'W').add(t)",
    "",
  ].join("\n");
  const header = 'import { workflow, trigger } from "@n8n/workflow-sdk";\n';

  test.each([
    ['export const meta = {\n  active: true,\n  updatedAt: "old",\n};', "multi-line"],
    [
      'export const meta: TsWorkflowMeta = {\n  active: true,\n  updatedAt: "old",\n};',
      "annotated",
    ],
    ['export const meta = { active: true, updatedAt: "old" };', "single-line"],
    ["export const meta = {\n  active: true,\n};", "no existing stamp"],
  ])("%s (%s)", (meta) => {
    const patched = patchTsStamp(`${header}${meta}${workflowTail}`, STAMP);
    expect(patched).not.toBeNull();
    expect(parseTsWorkflow(patched as string, "wf1").updatedAt).toBe(STAMP);
  });
});

describe("quoted keys do not become duplicate properties", () => {
  /**
   * A quoted key declares the same property as the bare form. Skipping past it
   * and inserting another is not a cosmetic problem: in an object literal the
   * last one wins, so the file would keep reporting its old revision forever,
   * and in YAML a duplicate mapping key stops the file loading at all.
   */
  test.each([
    ['"updatedAt": "old"', 'export const meta = {\n  active: true,\n  "updatedAt": "old",\n};\n'],
    ["'updatedAt': 'old'", "export const meta = {\n  active: true,\n  'updatedAt': 'old',\n};\n"],
  ])(".ts with %s is replaced in place", (_label, text) => {
    const out = patchTsStamp(text, STAMP);
    expect(out?.match(/updatedAt/g)).toHaveLength(1);
    expect(out).toContain(STAMP);
  });

  test(".ts whose stamp is not a plain string literal is left untouched", () => {
    // Inserting here would duplicate the key, and the stale value would win.
    expect(patchTsStamp("export const meta = {\n  updatedAt: `old`,\n};\n", STAMP)).toBeNull();
  });

  test.each([
    ["single-quoted", "id: wf1\nname: x\nactive: false\n'updatedAt': 'old'\nnodes: []\n"],
    ["double-quoted", 'id: wf1\nname: x\nactive: false\n"updatedAt": "old"\nnodes: []\n'],
  ])("YAML with a %s key stays loadable", (_label, text) => {
    const out = patchYamlStamp(text, STAMP) as string;
    expect(out.match(/updatedAt/g)).toHaveLength(1);
    expect((yaml.load(out) as Record<string, unknown>).updatedAt).toBe(STAMP);
  });

  test("YAML anchors are found even when quoted", () => {
    const out = patchYamlStamp("'id': wf1\n'name': x\n'active': false\nnodes: []\n", STAMP);
    expect((yaml.load(out as string) as Record<string, unknown>).updatedAt).toBe(STAMP);
  });
});
