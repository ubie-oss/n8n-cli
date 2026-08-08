import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncludeRef } from "@/yaml/include-schema.ts";
import { loadYamlWorkflow } from "@/yaml/loader.ts";

const fixturesDir = path.resolve(import.meta.dir, "../fixtures");

describe("loadYamlWorkflow", () => {
  test("loads a simple YAML workflow", () => {
    const filePath = path.join(fixturesDir, "simple-workflow.yaml");
    const workflow = loadYamlWorkflow(filePath);

    expect(workflow.id).toBe("test123");
    expect(workflow.name).toBe("テストワークフロー");
    expect(workflow.active).toBe(false);
    expect(workflow.nodes).toHaveLength(2);
    expect(workflow.nodes[0]!.name).toBe("手動トリガー");
    expect(workflow.nodes[1]!.name).toBe("コード実行");
    expect(workflow.nodes[1]!.parameters?.jsCode).toBe("return [{json: {hello: 'world'}}];");
  });

  test("resolves !include tags", () => {
    const filePath = path.join(fixturesDir, "workflow-with-include.yaml");
    const workflow = loadYamlWorkflow(filePath);

    expect(workflow.id).toBe("incl456");
    expect(workflow.nodes).toHaveLength(2);

    const codeNode = workflow.nodes[1]!;
    const jsCode = codeNode.parameters?.jsCode as string;
    expect(jsCode).toContain("const items = $input.all();");
    expect(jsCode).toContain("processed: true");
  });

  test("resolves connections correctly", () => {
    const filePath = path.join(fixturesDir, "simple-workflow.yaml");
    const workflow = loadYamlWorkflow(filePath);

    const triggerConns = workflow.connections.手動トリガー;
    expect(triggerConns).toBeDefined();
    expect(triggerConns!.main).toHaveLength(1);
    expect(triggerConns!.main![0]).toHaveLength(1);
    expect(triggerConns!.main![0]![0]!.node).toBe("コード実行");
  });

  test("throws on nonexistent file", () => {
    expect(() => loadYamlWorkflow("/nonexistent/file.yaml")).toThrow("failed to read YAML file");
  });

  test("throws on invalid YAML", () => {
    // Create a temp file with invalid YAML
    const tmpPath = path.join(fixturesDir, "__invalid_test.yaml");
    require("node:fs").writeFileSync(tmpPath, ":\n  :\n  - : :\n  invalid: [unclosed", "utf-8");

    try {
      expect(() => loadYamlWorkflow(tmpPath)).toThrow("YAML parse error");
    } finally {
      require("node:fs").unlinkSync(tmpPath);
    }
  });

  test("throws on !include with nonexistent file", () => {
    const tmpPath = path.join(fixturesDir, "__missing_include_test.yaml");
    require("node:fs").writeFileSync(
      tmpPath,
      "id: test\nname: test\nnodes:\n  - id: x\n    name: x\n    type: x\n    typeVersion: 1\n    position: [0,0]\n    parameters:\n      code: !include nonexistent-file.js\nconnections: {}\n",
      "utf-8",
    );

    try {
      expect(() => loadYamlWorkflow(tmpPath)).toThrow("!include failed");
    } finally {
      require("node:fs").unlinkSync(tmpPath);
    }
  });

  test("resolveIncludes: false preserves IncludeRef objects", () => {
    const filePath = path.join(fixturesDir, "workflow-with-include.yaml");
    const workflow = loadYamlWorkflow(filePath, { resolveIncludes: false });

    expect(workflow.id).toBe("incl456");
    const codeNode = workflow.nodes[1]!;
    const jsCode = codeNode.parameters?.jsCode;
    expect(jsCode).toBeInstanceOf(IncludeRef);
    expect((jsCode as IncludeRef).path).toBe("included-code.js");
  });

  test("resolveIncludes: true (default) resolves IncludeRef to file contents", () => {
    const filePath = path.join(fixturesDir, "workflow-with-include.yaml");
    const workflow = loadYamlWorkflow(filePath);

    const codeNode = workflow.nodes[1]!;
    const jsCode = codeNode.parameters?.jsCode as string;
    expect(typeof jsCode).toBe("string");
    expect(jsCode).toContain("const items = $input.all();");
  });
});

describe("workflow timestamps", () => {
  /**
   * YAML's implicit typing turns an unquoted ISO timestamp into a `Date`, which
   * `resolveIncludeRefs` then flattens to `{}` while walking the document. That
   * silently destroyed the value — conflict detection saw an unparseable stamp
   * and stopped detecting anything, and `apply` sent `[object Object]` upstream
   * as its base revision.
   */
  test("an unquoted updatedAt survives as an ISO string", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-ts-"));
    try {
      const file = path.join(dir, "wf.yaml");
      fs.writeFileSync(
        file,
        "id: wf1\nname: x\nactive: false\nupdatedAt: 2026-03-01T10:00:00.000Z\nnodes: []\nconnections: {}\n",
      );

      const workflow = loadYamlWorkflow(file);

      expect(typeof workflow.updatedAt).toBe("string");
      expect(workflow.updatedAt).toBe("2026-03-01T10:00:00.000Z");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a quoted updatedAt is left exactly as written", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-ts-"));
    try {
      const file = path.join(dir, "wf.yaml");
      fs.writeFileSync(
        file,
        "id: wf1\nname: x\nactive: false\nupdatedAt: '2026-03-01T10:00:00.000Z'\nnodes: []\nconnections: {}\n",
      );

      expect(loadYamlWorkflow(file).updatedAt).toBe("2026-03-01T10:00:00.000Z");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
