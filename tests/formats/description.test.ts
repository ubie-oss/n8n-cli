import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { compare } from "@/apply/differ.ts";
import { ThreeWayDetector } from "@/apply/threeway/detector.ts";
import { generateTsWorkflow } from "@/ts/generator.ts";
import { parseTsWorkflow } from "@/ts/loader.ts";
import { buildYamlObject } from "@/yaml/generator.ts";

/**
 * The workflow-level `description` is what n8n's MCP server hands an agent as
 * the tool description, so it has to survive every format n8n-cli writes and
 * has to register as a change when it differs — otherwise apply would never
 * push an edited one.
 */

const base: Workflow = {
  id: "wf-1",
  name: "Hospital lookup",
  active: false,
  nodes: [
    {
      id: "n1",
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 0],
      parameters: {},
    },
  ],
  connections: {},
};

const DESCRIPTION = "Looks up a hospital by name and returns its contract status.";

describe("workflow description: YAML", () => {
  test("is emitted when set", () => {
    const result = buildYamlObject({ ...base, description: DESCRIPTION }, {});
    expect(result.description).toBe(DESCRIPTION);
  });

  test("is absent — not empty — when the workflow has none", () => {
    const result = buildYamlObject(base, {});
    expect("description" in result).toBe(false);
  });
});

describe("workflow description: .ts", () => {
  test("round-trips through the meta block", () => {
    const code = generateTsWorkflow({ ...base, description: DESCRIPTION });
    expect(code).toContain("description:");
    const back = parseTsWorkflow(code, base.id ?? "");
    expect(back.description).toBe(DESCRIPTION);
  });

  test("a workflow without one does not acquire an empty description", () => {
    const back = parseTsWorkflow(generateTsWorkflow(base), base.id ?? "");
    expect(back.description).toBeUndefined();
  });

  test("survives characters that need escaping", () => {
    const tricky = 'Line one\n"quoted" and ${notAnExpression} and 日本語';
    const back = parseTsWorkflow(
      generateTsWorkflow({ ...base, description: tricky }),
      base.id ?? "",
    );
    expect(back.description).toBe(tricky);
  });
});

describe("workflow description: diffing", () => {
  test("a changed description is a change", () => {
    const diff = compare({ ...base, description: DESCRIPTION }, { ...base, description: "old" });
    expect(diff.hasChanges).toBe(true);
    expect(diff.fields.map((f) => f.field)).toContain("description");
  });

  test("absent and empty are the same description", () => {
    const diff = compare(base, { ...base, description: "" });
    expect(diff.fields.map((f) => f.field)).not.toContain("description");
    expect(diff.hasChanges).toBe(false);
  });

  test("a definition that carries no description does not fight one written upstream", () => {
    // The alternative is worse than a missing feature: apply would report a
    // change and then push an update with no `description` field at all,
    // either wiping what someone wrote in the n8n UI or never converging.
    const diff = compare(base, { ...base, description: "written in the n8n UI" });
    expect(diff.fields.map((f) => f.field)).not.toContain("description");
    expect(diff.hasChanges).toBe(false);
  });

  test("an explicitly empty description does clear one upstream", () => {
    const diff = compare({ ...base, description: "" }, { ...base, description: "old" });
    expect(diff.fields.map((f) => f.field)).toContain("description");
  });

  test("the three-way detector sees a local-only description edit as an update", () => {
    const detector = new ThreeWayDetector();
    const result = detector.detect(base, { ...base, description: DESCRIPTION }, base);
    expect(result.type).toBe("update");
    expect(result.baseToLocal?.changedFields).toContain("description");
  });

  test("a description written in the n8n UI does not turn an unrelated edit into a conflict", () => {
    // `remote` comes from the API, `base` from the git base ref. Every
    // definition written before description support lacks the key, so
    // comparing the two symmetrically made "someone typed a description in the
    // UI" read as a remote change — and, paired with any local edit, as a
    // conflict needing --force. Nothing is at risk: apply never sends a
    // description the local file does not declare.
    const detector = new ThreeWayDetector();
    const local = { ...base, name: "renamed locally" };
    const remote = { ...base, description: "written in the n8n UI" };

    const result = detector.detect(base, local, remote);

    expect(result.type).toBe("update");
    expect(result.baseToRemote?.changedFields ?? []).not.toContain("description");
  });

  test("a genuine divergence is still a conflict", () => {
    const detector = new ThreeWayDetector();
    const result = detector.detect(base, { ...base, name: "local" }, { ...base, name: "remote" });
    expect(result.type).toBe("conflict");
  });
});
