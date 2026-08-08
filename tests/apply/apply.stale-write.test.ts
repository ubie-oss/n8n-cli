import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow, WorkflowInput } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { Executor } from "@/apply/executor.ts";
import { defaultApplyOptions } from "@/apply/types.ts";
import { loadYamlWorkflow } from "@/yaml/loader.ts";

/**
 * What a persisted `updatedAt` buys `apply` for YAML definitions.
 *
 * Before it, YAML carried no timestamp: 3-way detection skips the format and
 * 2-way needs a local stamp to compare, so a definition written from a stale
 * checkout was pushed unconditionally and reverted whatever had been changed
 * in the n8n UI. These tests pin the two halves of the fix — the conflict is
 * now detected, and a successful write leaves the file current so the *next*
 * edit is not mistaken for one.
 */

const REMOTE_UPDATED = "2026-03-01T10:00:00.000Z";
const LOCAL_BASE = "2026-02-01T10:00:00.000Z";

interface Recorded {
  updates: { id: string; input: WorkflowInput; baseUpdatedAt?: string }[];
}

function remoteWorkflow(): Workflow {
  return {
    id: "wf1",
    name: "remote name",
    active: false,
    nodes: [],
    connections: {},
    updatedAt: REMOTE_UPDATED,
  } as Workflow;
}

function mockService(remote: Workflow): { service: WorkflowService; recorded: Recorded } {
  const recorded: Recorded = { updates: [] };
  const service = {
    listAllWorkflows: async () => [remote],
    getWorkflow: async () => remote,
    createWorkflow: async (input: WorkflowInput) => ({ ...input, id: "wf1" }) as Workflow,
    updateWorkflow: async (id: string, input: WorkflowInput, baseUpdatedAt?: string) => {
      recorded.updates.push({ id, input, baseUpdatedAt });
      return { ...remote, ...input, updatedAt: "2026-04-01T00:00:00.000Z" } as Workflow;
    },
    getWorkflowCurrentProjectID: () => "",
  } as unknown as WorkflowService;
  return { service, recorded };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-apply-stale-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a YAML definition whose content differs from the remote's. */
function writeLocalYaml(updatedAt: string | undefined): string {
  const file = path.join(dir, "wf__wf1.yaml");
  const lines = ["id: wf1", "name: local name", "active: false"];
  if (updatedAt) lines.push(`updatedAt: '${updatedAt}'`);
  lines.push("nodes: []", "connections: {}", "");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

function executor(service: WorkflowService, overrides: Record<string, unknown> = {}): Executor {
  const opts = defaultApplyOptions();
  opts.directory = dir;
  opts.all = true;
  opts.yamlEnabled = true;
  opts.noLint = true;
  opts.allowDuplicates = true;
  Object.assign(opts, overrides);
  return new Executor(service, opts);
}

describe("apply against a YAML definition with a stamp", () => {
  test("a stale local definition is reported as a conflict, not pushed", async () => {
    writeLocalYaml(LOCAL_BASE);
    const { service, recorded } = mockService(remoteWorkflow());

    const result = await executor(service).execute();

    expect(result.conflictCount).toBe(1);
    expect(result.operations[0]?.operation).toBe("conflict");
    expect(recorded.updates).toHaveLength(0);
  });

  test("--force pushes the stale definition anyway", async () => {
    writeLocalYaml(LOCAL_BASE);
    const { service, recorded } = mockService(remoteWorkflow());

    const result = await executor(service, { force: true }).execute();

    expect(result.operations[0]?.forced).toBe(true);
    expect(recorded.updates).toHaveLength(1);
  });

  test("a current definition is applied and declares the base it was built on", async () => {
    writeLocalYaml(REMOTE_UPDATED);
    const { service, recorded } = mockService(remoteWorkflow());

    const result = await executor(service).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.updates[0]?.baseUpdatedAt).toBe(REMOTE_UPDATED);
  });

  test("the local file is re-stamped so the next edit is not a false conflict", async () => {
    const file = writeLocalYaml(REMOTE_UPDATED);
    const { service } = mockService(remoteWorkflow());

    await executor(service).execute();

    expect(loadYamlWorkflow(file).updatedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  test("a definition with no stamp still applies, declaring no base", async () => {
    writeLocalYaml(undefined);
    const { service, recorded } = mockService(remoteWorkflow());

    const result = await executor(service).execute();

    expect(result.updateCount).toBe(1);
    expect(recorded.updates[0]?.baseUpdatedAt).toBeUndefined();
  });
});
