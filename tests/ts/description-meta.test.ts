import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { generateTsWorkflow } from "@/ts/generator.ts";
import { parseTsWorkflow } from "@/ts/loader.ts";
import { buildYamlObject } from "@/yaml/generator.ts";

/**
 * `description` and the folder hints have to survive every format, or a
 * `convert` between them would silently drop what a definition declared. The
 * absent-vs-empty distinction has to survive too: only a file that carries the
 * field manages it, so a generator that emitted `description: ""` for every
 * workflow would turn a format change into a mass clearing of descriptions.
 */

function workflow(extra: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf1",
    name: "Example",
    active: false,
    nodes: [
      {
        id: "n1",
        name: "Start",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
      },
    ],
    connections: {},
    ...extra,
  };
}

describe("TypeScript format", () => {
  test("round-trips a description through meta", () => {
    const code = generateTsWorkflow(workflow({ description: "what this does" }));
    expect(code).toContain('description: "what this does"');
    expect(parseTsWorkflow(code, "wf1").description).toBe("what this does");
  });

  test("omits description entirely when the workflow has none", () => {
    const code = generateTsWorkflow(workflow());
    expect(code).not.toContain("description:");
    expect(parseTsWorkflow(code, "wf1").description).toBeUndefined();
  });

  test("round-trips folderPath and folderId", () => {
    const code = generateTsWorkflow(workflow({ folderPath: "Ops/Billing", folderId: "f1" }));
    const parsed = parseTsWorkflow(code, "wf1");
    expect(parsed.folderPath).toBe("Ops/Billing");
    expect(parsed.folderId).toBe("f1");
  });

  test("preserves an explicit empty description, which means 'clear it'", () => {
    // Hand-authored rather than generated: the generator never emits an empty
    // description, but a person may write one deliberately.
    const code = generateTsWorkflow(workflow()).replace(
      "active: false,",
      'active: false,\n  description: "",',
    );
    expect(parseTsWorkflow(code, "wf1").description).toBe("");
  });

  test("rejects a non-string description rather than guessing", () => {
    const code = generateTsWorkflow(workflow()).replace(
      "active: false,",
      "active: false,\n  description: 42,",
    );
    expect(() => parseTsWorkflow(code, "wf1")).toThrow(/description must be a string/);
  });
});

describe("YAML format", () => {
  test("emits a description when the workflow has one", () => {
    expect(buildYamlObject(workflow({ description: "docs" }), {}).description).toBe("docs");
  });

  test("omits the key when the workflow has none", () => {
    expect("description" in buildYamlObject(workflow(), {})).toBe(false);
  });

  test("carries the folder hints across a conversion", () => {
    const built = buildYamlObject(workflow({ folderPath: "Ops", folderId: "f1" }), {});
    expect(built.folderPath).toBe("Ops");
    expect(built.folderId).toBe("f1");
  });
});
