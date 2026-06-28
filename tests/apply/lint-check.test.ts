import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow, WorkflowInput } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { Executor } from "@/apply/executor.ts";
import { type ApplyOptions, defaultApplyOptions } from "@/apply/types.ts";

/**
 * Tracks API mutations so tests can assert that lint failures actually
 * short-circuit the write — not just the operation type, but the underlying
 * API call. A blocked workflow must produce zero create/update calls.
 */
interface MockCalls {
  creates: WorkflowInput[];
  updates: Array<{ id: string; input: WorkflowInput }>;
}

function mockWorkflowService(opts: { existing?: Workflow[] } = {}): {
  service: WorkflowService;
  calls: MockCalls;
} {
  const calls: MockCalls = { creates: [], updates: [] };
  const existingById = new Map<string, Workflow>();
  for (const wf of opts.existing ?? []) {
    if (wf.id) existingById.set(wf.id, wf);
  }
  const service = {
    listAllWorkflows: async () => opts.existing ?? [],
    getWorkflow: async (id: string) => {
      const wf = existingById.get(id);
      if (!wf) {
        const err = new Error("not found") as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      return wf;
    },
    createWorkflow: async (input: WorkflowInput) => {
      calls.creates.push(input);
      return { ...(input as object), id: "new-id" } as Workflow;
    },
    updateWorkflow: async (id: string, input: WorkflowInput) => {
      calls.updates.push({ id, input });
      return { ...(input as object), id } as Workflow;
    },
    getWorkflowCurrentProjectID: () => "",
  } as unknown as WorkflowService;
  return { service, calls };
}

/** Workflow with a connection referencing a missing node — triggers the
 *  default-error `connection-reference` rule. */
function badWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "broken-wf",
    active: false,
    nodes: [
      {
        id: "n1",
        name: "Start",
        type: "n8n-nodes-base.start",
        typeVersion: 1,
        position: [0, 0],
      },
    ],
    connections: {
      Start: {
        main: [[{ node: "MissingNode", type: "main", index: 0 }]],
      },
    },
    ...overrides,
  };
}

/** Clean workflow — no lint violations. */
function goodWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "clean-wf",
    active: false,
    nodes: [
      {
        id: "n1",
        name: "Start",
        type: "n8n-nodes-base.start",
        typeVersion: 1,
        position: [0, 0],
      },
    ],
    connections: {},
    ...overrides,
  };
}

describe("apply pre-write lint check", () => {
  let tmpDir: string;
  let opts: ApplyOptions;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-lint-test-"));
    opts = {
      ...defaultApplyOptions(),
      directory: tmpDir,
      all: true,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("blocks create when local workflow has error-level lint violation", async () => {
    const file = path.join(tmpDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify(badWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, opts).execute();

    expect(result.errorCount).toBe(1);
    expect(result.operations[0]?.operation).toBe("error");
    expect(result.operations[0]?.error?.message).toContain("lint check failed");
    expect(result.operations[0]?.error?.message).toContain("connection-reference");
    // The "; pass --no-lint to bypass" tail is part of the documented apply
    // UX — CI consumers grep for it. Keep it in the error message.
    expect(result.operations[0]?.error?.message).toContain("pass --no-lint to bypass");
    expect(calls.creates).toHaveLength(0);
  });

  test("passes clean workflow through to create", async () => {
    const file = path.join(tmpDir, "clean.json");
    fs.writeFileSync(file, JSON.stringify(goodWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, opts).execute();

    expect(result.errorCount).toBe(0);
    expect(result.createCount).toBe(1);
    expect(calls.creates).toHaveLength(1);
  });

  test("--no-lint (noLint=true) skips the gate and forwards the broken workflow", async () => {
    const file = path.join(tmpDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify(badWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, { ...opts, noLint: true }).execute();

    expect(result.errorCount).toBe(0);
    expect(result.createCount).toBe(1);
    expect(calls.creates).toHaveLength(1);
  });

  test("--force does NOT bypass lint failures (policy, not merge conflict)", async () => {
    const file = path.join(tmpDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify(badWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, { ...opts, force: true }).execute();

    expect(result.errorCount).toBe(1);
    expect(calls.creates).toHaveLength(0);
  });

  test("dry-run also surfaces lint errors without writing", async () => {
    const file = path.join(tmpDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify(badWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, { ...opts, dryRun: true }).execute();

    expect(result.errorCount).toBe(1);
    expect(result.operations[0]?.operation).toBe("error");
    expect(calls.creates).toHaveLength(0);
  });

  test("lintDisableRules turns off the failing rule and lets the apply pass", async () => {
    const file = path.join(tmpDir, "broken.json");
    fs.writeFileSync(file, JSON.stringify(badWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, {
      ...opts,
      lintDisableRules: ["connection-reference"],
    }).execute();

    expect(result.errorCount).toBe(0);
    expect(result.createCount).toBe(1);
    expect(calls.creates).toHaveLength(1);
  });

  test("mixes blocked and clean workflows in one apply (partial run)", async () => {
    fs.writeFileSync(path.join(tmpDir, "broken.json"), JSON.stringify(badWorkflow()));
    fs.writeFileSync(path.join(tmpDir, "clean.json"), JSON.stringify(goodWorkflow()));

    const { service, calls } = mockWorkflowService();
    const result = await new Executor(service, opts).execute();

    expect(result.errorCount).toBe(1);
    expect(result.createCount).toBe(1);
    expect(calls.creates).toHaveLength(1);
    expect(calls.creates[0]?.name).toBe("clean-wf");
  });

  // Regression test: warning-level lint violations were being attached to
  // `op.lintViolations` but never read by the reporter. Verify the field is
  // populated so the reporter can surface it.
  test("warning-level violations are recorded on op.lintViolations (not silently dropped)", async () => {
    // Workflow that triggers `orphaned-node` (default severity: warning).
    // An orphaned node has no incoming and no outgoing connections AND is
    // not a trigger node type. Use a non-trigger node to ensure the rule
    // fires.
    const wf: Workflow = {
      name: "warn-wf",
      active: false,
      nodes: [
        {
          id: "n1",
          name: "Set",
          type: "n8n-nodes-base.set",
          typeVersion: 1,
          position: [0, 0],
        },
      ],
      connections: {},
    };
    fs.writeFileSync(path.join(tmpDir, "warn.json"), JSON.stringify(wf));

    const { service } = mockWorkflowService();
    const result = await new Executor(service, opts).execute();

    expect(result.errorCount).toBe(0);
    expect(result.createCount).toBe(1);
    const op = result.operations[0];
    expect(op?.lintViolations).toBeDefined();
    // At least one warning should be present (orphaned-node).
    const warns = op?.lintViolations?.filter((v) => v.severity === "warning") ?? [];
    expect(warns.length).toBeGreaterThan(0);
  });

  test("malformed .n8nlintrc.json throws LintConfigLoadError from `new Executor(...)`", async () => {
    // Write an invalid lint config so prepare() must throw.
    const badConfig = path.join(tmpDir, ".n8nlintrc.json");
    fs.writeFileSync(badConfig, "{ not valid json");
    fs.writeFileSync(path.join(tmpDir, "wf.json"), JSON.stringify(goodWorkflow()));
    opts.lintConfigPath = badConfig;

    const { service } = mockWorkflowService();
    // The apply CLI catches this around `new Executor(...)` to print a
    // friendly error + bypass hint. The throw must happen from the
    // constructor — not from execute() — for that catch to fire.
    const { LintConfigLoadError } = await import("@/lint/write-check.ts");
    expect(() => new Executor(service, opts)).toThrow(LintConfigLoadError);
  });
});
