import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFileForLint } from "@/lint/scanner.ts";

describe("loadFileForLint tag filter fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-cmd-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBrokenYaml(filename: string, tags: { id: string; name: string }[]): string {
    const tagsYaml =
      tags.length > 0
        ? `tags:\n${tags.map((t) => `  - id: ${t.id}\n    name: ${t.name}`).join("\n")}`
        : "tags: []";

    const content = [
      "id: wf1",
      "name: Broken Workflow",
      "active: false",
      tagsYaml,
      "nodes:",
      "  - id: n1",
      "    name: Node1",
      "    type: test",
      "    typeVersion: 1",
      "    position: [0, 0]",
      "    parameters:",
      "      code: !include nonexistent-file.js",
      "connections: {}",
    ].join("\n");

    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  test("broken YAML with non-matching tags returns skipped when tag filter is active", async () => {
    const filePath = writeBrokenYaml("no-match.yaml", [{ id: "t1", name: "other-tag" }]);

    const outcome = await loadFileForLint(filePath, ["managed-as-code"]);

    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.message).toContain("skipped by tag filter");
    }
  });

  test("broken YAML with matching tags returns error when tag filter is active", async () => {
    const filePath = writeBrokenYaml("match.yaml", [{ id: "t1", name: "managed-as-code" }]);

    const outcome = await loadFileForLint(filePath, ["managed-as-code"]);

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.message).toContain("Failed to read file");
    }
  });

  test("broken YAML returns error when no tag filter is active", async () => {
    const filePath = writeBrokenYaml("no-filter.yaml", [{ id: "t1", name: "some-tag" }]);

    const outcome = await loadFileForLint(filePath, []);

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.message).toContain("Failed to read file");
    }
  });

  test("broken YAML with no tags returns skipped when tag filter is active", async () => {
    const filePath = writeBrokenYaml("no-tags.yaml", []);

    const outcome = await loadFileForLint(filePath, ["managed-as-code"]);

    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.message).toContain("skipped by tag filter");
    }
  });

  test("valid YAML returns loaded", async () => {
    const content = [
      "id: wf1",
      "name: Valid Workflow",
      "active: false",
      "tags: []",
      "nodes:",
      "  - id: n1",
      "    name: Node1",
      "    type: test",
      "    typeVersion: 1",
      "    position: [0, 0]",
      "    parameters: {}",
      "connections: {}",
    ].join("\n");
    const filePath = path.join(tmpDir, "valid.yaml");
    fs.writeFileSync(filePath, content);

    const outcome = await loadFileForLint(filePath, ["some-tag"]);

    expect(outcome.status).toBe("loaded");
    if (outcome.status === "loaded") {
      expect(outcome.data.workflow).not.toBeNull();
      expect(outcome.data.workflow!.name).toBe("Valid Workflow");
    }
  });
});
