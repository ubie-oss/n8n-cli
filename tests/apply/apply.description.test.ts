import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow, WorkflowInput } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { Executor } from "@/apply/executor.ts";
import { defaultApplyOptions } from "@/apply/types.ts";

/**
 * The workflow `description` on the wire.
 *
 * It is the text n8n's MCP server shows an agent as the tool description, so a
 * definition that carries one has to actually push it. The opposite matters
 * just as much: a definition without one must not start sending an empty
 * `description`, which an n8n old enough to validate strictly rejects outright.
 */

const DESCRIPTION = "Looks up a hospital by name and returns its contract status.";

interface Recorded {
  updates: WorkflowInput[];
  creates: WorkflowInput[];
}

function remoteWorkflow(description?: string): Workflow {
  return {
    id: "wf1",
    name: "wf",
    active: false,
    nodes: [],
    connections: {},
    ...(description !== undefined ? { description } : {}),
  };
}

function mockService(remote: Workflow): { service: WorkflowService; recorded: Recorded } {
  const recorded: Recorded = { updates: [], creates: [] };
  const service = {
    listAllWorkflows: async () => [remote],
    getWorkflow: async () => remote,
    createWorkflow: async (input: WorkflowInput) => {
      recorded.creates.push(input);
      return { ...input, id: "wf1" } as Workflow;
    },
    updateWorkflow: async (_id: string, input: WorkflowInput) => {
      recorded.updates.push(input);
      return { ...remote, ...input } as Workflow;
    },
    getWorkflowCurrentProjectID: () => "",
  } as unknown as WorkflowService;
  return { service, recorded };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-apply-desc-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLocalYaml(lines: string[]): void {
  fs.writeFileSync(path.join(dir, "wf__wf1.yaml"), [...lines, ""].join("\n"));
}

function executor(service: WorkflowService): Executor {
  const opts = defaultApplyOptions();
  opts.directory = dir;
  opts.all = true;
  opts.yamlEnabled = true;
  opts.noLint = true;
  opts.allowDuplicates = true;
  return new Executor(service, opts);
}

describe("apply and the workflow description", () => {
  test("a locally edited description is pushed", async () => {
    writeLocalYaml([
      "id: wf1",
      "name: wf",
      `description: ${JSON.stringify(DESCRIPTION)}`,
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, recorded } = mockService(remoteWorkflow("stale text"));

    const result = await executor(service).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.updates[0]?.description).toBe(DESCRIPTION);
  });

  test("a definition without one sends no description at all", async () => {
    writeLocalYaml(["id: wf1", "name: wf", "active: false", "nodes: []", "connections: {}"]);
    const { service, recorded } = mockService(remoteWorkflow());

    // Nothing differs, so nothing is written — force a difference elsewhere.
    fs.writeFileSync(
      path.join(dir, "wf__wf1.yaml"),
      ["id: wf1", "name: renamed", "active: false", "nodes: []", "connections: {}", ""].join("\n"),
    );

    await executor(service).execute();

    expect(recorded.updates).toHaveLength(1);
    expect("description" in (recorded.updates[0] as object)).toBe(false);
  });

  test("settings.availableInMCP travels with the write", async () => {
    // The MCP toggle is a workflow setting, and apply strips a handful of
    // settings n8n exports but rejects. This one must not join that list: n8n
    // has accepted it over the public API since 2.17.0, and dropping it would
    // silently un-expose the workflow on every apply.
    writeLocalYaml([
      "id: wf1",
      "name: wf",
      "active: false",
      "nodes: []",
      "connections: {}",
      "settings:",
      "  availableInMCP: true",
    ]);
    const { service, recorded } = mockService(remoteWorkflow());

    await executor(service).execute();

    expect(recorded.updates).toHaveLength(1);
    expect(recorded.updates[0]?.settings?.availableInMCP).toBe(true);
  });

  test("a description-only edit is enough to trigger a write", async () => {
    writeLocalYaml([
      "id: wf1",
      "name: wf",
      `description: ${JSON.stringify(DESCRIPTION)}`,
      "active: false",
      "nodes: []",
      "connections: {}",
    ]);
    const { service, recorded } = mockService(remoteWorkflow());

    const result = await executor(service).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.updates[0]?.description).toBe(DESCRIPTION);
  });
});
