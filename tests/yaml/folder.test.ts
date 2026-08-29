import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import type { Workflow } from "../../src/api/types.ts";
import { buildYamlObject } from "../../src/yaml/generator.ts";
import { loadYamlWorkflow } from "../../src/yaml/loader.ts";

/**
 * The `folder` key in the YAML format. It is the only record of a workflow's
 * folder assignment the local file has — the REST API refuses to report it —
 * so the round trip must be exact, including the "managed project root"
 * case, which must not be collapsed into "absent".
 */

function baseWorkflow(): Workflow {
  return {
    id: "wf1",
    name: "wf",
    active: false,
    nodes: [],
    connections: {},
  } as Workflow;
}

describe("buildYamlObject: folder", () => {
  test("a declared folder path is written", () => {
    const wf = { ...baseWorkflow(), folder: "Reporting/Daily" };
    const obj = buildYamlObject(wf, {});
    expect(obj.folder).toBe("Reporting/Daily");
  });

  test("an explicit root assignment is written as folder: null, never dropped", () => {
    // Dropping the key would silently stop managing the assignment: on apply,
    // "absent" means "leave the folder alone".
    const obj = buildYamlObject({ ...baseWorkflow(), folder: null }, {});
    expect("folder" in obj).toBe(true);
    expect(obj.folder).toBeNull();
  });

  test("an undeclared folder writes no key at all", () => {
    const obj = buildYamlObject(baseWorkflow(), {});
    expect("folder" in obj).toBe(false);
  });

  test("the dumped YAML round-trips folder: null through the loader", () => {
    const obj = buildYamlObject({ ...baseWorkflow(), folder: null }, {});
    const text = yaml.dump(obj, { noRefs: true, quotingType: '"' });
    const loaded = loadYamlText(text);
    expect(loaded.folder).toBeNull();
  });

  test("the dumped YAML round-trips a folder path through the loader", () => {
    const obj = buildYamlObject({ ...baseWorkflow(), folder: "Reporting/Daily" }, {});
    const text = yaml.dump(obj, { noRefs: true, quotingType: '"' });
    const loaded = loadYamlText(text);
    expect(loaded.folder).toBe("Reporting/Daily");
  });
});

function loadYamlText(text: string): Workflow {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-yaml-folder-")), "w.yaml");
  fs.writeFileSync(file, text);
  return loadYamlWorkflow(file);
}
