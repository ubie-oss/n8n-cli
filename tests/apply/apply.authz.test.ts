import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow, WorkflowInput } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { Executor } from "@/apply/executor.ts";
import { defaultApplyOptions } from "@/apply/types.ts";

/**
 * End-to-end-ish apply tests with authz middleware enabled.
 *
 * Spawns a fake groups API via Bun.serve and drives Executor against it,
 * verifying that allow/deny decisions actually translate to whether the
 * mock WorkflowService.createWorkflow is invoked.
 */

interface MockCalls {
  creates: WorkflowInput[];
}

function mockService(): { service: WorkflowService; calls: MockCalls } {
  const calls: MockCalls = { creates: [] };
  const service = {
    listAllWorkflows: async () => [],
    getWorkflow: async (_id: string) => {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    },
    createWorkflow: async (input: WorkflowInput) => {
      calls.creates.push(input);
      return { ...(input as object), id: "new-id" } as Workflow;
    },
    updateWorkflow: async () => ({}) as Workflow,
    getWorkflowCurrentProjectID: () => "",
  } as unknown as WorkflowService;
  return { service, calls };
}

function startGroupsServer(table: Map<string, string[]>): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      let parsed: { email?: string };
      try {
        parsed = JSON.parse(body) as { email?: string };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const ids = (parsed.email && table.get(parsed.email)) || [];
      return new Response(JSON.stringify({ groups: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

let tmpDir: string;
let groupsServer: ReturnType<typeof Bun.serve>;
let table: Map<string, string[]>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-authz-"));
  table = new Map();
  groupsServer = startGroupsServer(table);
});

afterEach(() => {
  groupsServer.stop(true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeWorkflow(filename: string, wf: Workflow): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, JSON.stringify(wf));
  return p;
}

function workflow(name: string, owners: string[]): Workflow {
  return {
    name,
    active: false,
    nodes: [
      { id: "n1", name: "Start", type: "n8n-nodes-base.start", typeVersion: 1, position: [0, 0] },
    ],
    connections: {},
    tags: owners.map((id) => ({ name: `owner:${id}` })),
  };
}

function makeOptions(directory: string, overrides: Record<string, unknown> = {}) {
  const opts = defaultApplyOptions();
  opts.directory = directory;
  opts.all = true; // explicit scope (avoids the "no scope" guard)
  opts.noLint = true; // isolate authz behavior
  opts.middlewares = ["authz"];
  opts.middlewareCliOptions = {
    authzEnforce: "error",
    authzOnError: "deny",
    authzIdentitySource: "env",
    authzIdentityName: "TEST_USER_EMAIL",
    authzGroupsUrl: `http://127.0.0.1:${groupsServer.port}/groups`,
    authzGroupsMethod: "POST",
    authzGroupsHeaders: '{"content-type":"application/json"}',
    authzGroupsBody: '{"email": ${json:identity}}',
    authzGroupsExtract: "$.groups[*].id",
    authzGroupsCacheTtlMs: "0",
    authzGroupsTimeoutMs: "2000",
    authzWorkflowExtract: "$.tags[*].name",
    authzWorkflowStripPrefix: "owner:",
    ...overrides,
  };
  return opts;
}

describe("apply + authz", () => {
  test("identity in allowed groups → create succeeds", async () => {
    process.env.TEST_USER_EMAIL = "ryo@example.com";
    table.set("ryo@example.com", ["eng", "ops"]);
    writeWorkflow("wf.json", workflow("wf", ["eng"]));

    const { service, calls } = mockService();
    const executor = new Executor(service, makeOptions(tmpDir));
    const result = await executor.execute();

    expect(result.errorCount).toBe(0);
    expect(result.createCount).toBe(1);
    expect(calls.creates).toHaveLength(1);
    delete process.env.TEST_USER_EMAIL;
  });

  test("identity not in allowed groups → create blocked, no API call", async () => {
    process.env.TEST_USER_EMAIL = "ryo@example.com";
    table.set("ryo@example.com", ["ops"]);
    writeWorkflow("wf.json", workflow("wf", ["eng"]));

    const { service, calls } = mockService();
    const executor = new Executor(service, makeOptions(tmpDir));
    const result = await executor.execute();

    expect(result.errorCount).toBe(1);
    expect(calls.creates).toHaveLength(0);
    const op = result.operations[0]!;
    expect(op.blockedByMiddleware).toBe("authz");
    expect(op.middlewareViolations?.[0]?.rule).toBe("authz-denied");
    delete process.env.TEST_USER_EMAIL;
  });

  test("workflow without ACL tag → blocked with authz-no-acl", async () => {
    process.env.TEST_USER_EMAIL = "ryo@example.com";
    table.set("ryo@example.com", ["eng"]);
    writeWorkflow("wf.json", workflow("wf", []));

    const { service, calls } = mockService();
    const executor = new Executor(service, makeOptions(tmpDir));
    const result = await executor.execute();

    expect(result.errorCount).toBe(1);
    expect(calls.creates).toHaveLength(0);
    expect(result.operations[0]?.middlewareViolations?.[0]?.rule).toBe("authz-no-acl");
    delete process.env.TEST_USER_EMAIL;
  });

  test("missing identity env var → blocked with authz-missing-identity", async () => {
    delete process.env.TEST_USER_EMAIL;
    writeWorkflow("wf.json", workflow("wf", ["eng"]));

    const { service, calls } = mockService();
    const executor = new Executor(service, makeOptions(tmpDir));
    const result = await executor.execute();

    expect(result.errorCount).toBe(1);
    expect(calls.creates).toHaveLength(0);
    expect(result.operations[0]?.middlewareViolations?.[0]?.rule).toBe("authz-missing-identity");
  });

  test("groups API failure + onError=allow → create succeeds with warning", async () => {
    process.env.TEST_USER_EMAIL = "ryo@example.com";
    // No table entry → empty groups, but to assert the onError=allow path
    // specifically we point the resolver at a closed port.
    groupsServer.stop(true);
    writeWorkflow("wf.json", workflow("wf", ["eng"]));

    const { service, calls } = mockService();
    const opts = makeOptions(tmpDir, {
      authzGroupsUrl: "http://127.0.0.1:1/unreachable",
      authzOnError: "allow",
    });
    const executor = new Executor(service, opts);
    const result = await executor.execute();

    expect(result.errorCount).toBe(0);
    expect(calls.creates).toHaveLength(1);
    delete process.env.TEST_USER_EMAIL;
    // Restart so afterEach can stop it cleanly.
    groupsServer = startGroupsServer(table);
  });
});
