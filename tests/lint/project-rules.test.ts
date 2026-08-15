import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { loadLintConfig } from "@/lint/config.ts";
import { lintWorkflow } from "@/lint/engine.ts";
import { registerDefaultRules } from "@/lint/rules/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function loadConfig(raw: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-project-rules-"));
  temporaryDirectories.push(dir);
  const configPath = path.join(dir, ".n8nlintrc.json");
  fs.writeFileSync(configPath, JSON.stringify(raw));
  return loadLintConfig(configPath);
}

function workflow(nodeTypes: string[]): Workflow {
  return {
    name: "Project policy fixture",
    active: false,
    nodes: nodeTypes.map((type, index) => ({
      id: `node-${index}`,
      name: `Node ${index}`,
      type,
      typeVersion: 1,
      position: [index * 100, 0],
    })),
    connections: {},
  };
}

describe("project-scoped lint rules", () => {
  test("loads rules keyed by project ID", () => {
    const config = loadConfig({
      rules: { "required-fields": "warning" },
      projects: {
        "project-a": { rules: { "banned-node": ["error", { nodes: [] }] } },
      },
    });

    expect(config.rulesConfig.get("required-fields")?.severity).toBe("warning");
    expect(config.projectRulesConfig.get("project-a")?.get("banned-node")?.severity).toBe("error");
  });

  test("applies global and matching project rule option sets together", () => {
    const config = loadConfig({
      rules: {
        "banned-node": ["error", { nodes: [{ type: "global.node" }] }],
      },
      projects: {
        "project-a": {
          rules: {
            "banned-node": ["error", { nodes: [{ type: "project.node" }] }],
          },
        },
      },
    });
    const registry = registerDefaultRules();
    const input = workflow(["global.node", "project.node"]);

    const projectRules = registry.enabledRulesWithConfig(config, undefined, "project-a");
    const projectViolations = lintWorkflow(input, JSON.stringify(input), projectRules, config);
    expect(projectViolations.filter((v) => v.rule === "banned-node")).toHaveLength(2);

    const otherRules = registry.enabledRulesWithConfig(config, undefined, "project-b");
    const otherViolations = lintWorkflow(input, JSON.stringify(input), otherRules, config);
    expect(otherViolations.filter((v) => v.rule === "banned-node")).toHaveLength(1);
  });

  test("coalesces the same finding and keeps the stricter severity", () => {
    const nodes = [{ type: "shared.node" }];
    const config = loadConfig({
      rules: { "banned-node": ["warning", { nodes }] },
      projects: {
        "project-a": { rules: { "banned-node": ["error", { nodes }] } },
      },
    });
    const registry = registerDefaultRules();
    const input = workflow(["shared.node"]);
    const rules = registry.enabledRulesWithConfig(config, undefined, "project-a");

    const violations = lintWorkflow(input, JSON.stringify(input), rules, config).filter(
      (v) => v.rule === "banned-node",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("error");
  });

  test("a project can enable its layer when the global copy is off", () => {
    const config = loadConfig({
      rules: { "banned-node": "off" },
      projects: {
        "project-a": {
          rules: { "banned-node": ["error", { nodes: [{ type: "project.node" }] }] },
        },
      },
    });
    const registry = registerDefaultRules();
    const input = workflow(["project.node"]);

    const projectRules = registry.enabledRulesWithConfig(config, undefined, "project-a");
    expect(
      lintWorkflow(input, JSON.stringify(input), projectRules, config).filter(
        (v) => v.rule === "banned-node",
      ),
    ).toHaveLength(1);

    const globalRules = registry.enabledRulesWithConfig(config);
    expect(
      lintWorkflow(input, JSON.stringify(input), globalRules, config).filter(
        (v) => v.rule === "banned-node",
      ),
    ).toHaveLength(0);
  });
});
