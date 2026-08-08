import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow, WorkflowInput } from "@/api/types.ts";
import type { WorkflowService } from "@/api/workflow-service.ts";
import { Executor } from "@/apply/executor.ts";
import { defaultApplyOptions } from "@/apply/types.ts";

/**
 * Which revision a 3-way-cleared update declares as its base.
 *
 * 3-way exists precisely so a write does not depend on the local file's stamp:
 * it compares the change against the state it just fetched. Declaring the
 * file's own stamp anyway would hand a stale-write guard a revision nobody
 * checked, and the guard would refuse a write that apply has already verified
 * against current state — the common case being a CI apply whose re-stamp was
 * never committed back.
 */

const BASE_STAMP = "2026-01-01T00:00:00.000Z";
const REMOTE_STAMP = "2026-03-01T10:00:00.000Z";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

let repo: string;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-3way-")));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Commits a JSON definition, then edits it in a second commit. */
function commitThenEdit(): string {
  const dir = path.join(repo, "definitions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wf__wf1.json");

  const base = {
    id: "wf1",
    name: "base name",
    active: false,
    nodes: [],
    connections: {},
    updatedAt: BASE_STAMP,
  };
  fs.writeFileSync(file, JSON.stringify(base, null, 2));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");

  fs.writeFileSync(file, JSON.stringify({ ...base, name: "local edit" }, null, 2));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "edit");

  return file;
}

describe("3-way cleared update", () => {
  test("declares the revision it was verified against, not the file's stamp", async () => {
    commitThenEdit();

    // Remote matches the committed base in content, but its stamp has moved on
    // — the state a CI apply leaves behind when it never commits the re-stamp.
    const remote = {
      id: "wf1",
      name: "base name",
      active: false,
      nodes: [],
      connections: {},
      updatedAt: REMOTE_STAMP,
    } as Workflow;

    const declared: (string | undefined)[] = [];
    const service = {
      listAllWorkflows: async () => [remote],
      getWorkflow: async () => remote,
      createWorkflow: async (input: WorkflowInput) => ({ ...input, id: "wf1" }) as Workflow,
      updateWorkflow: async (_id: string, input: WorkflowInput, baseUpdatedAt?: string) => {
        declared.push(baseUpdatedAt);
        return { ...remote, ...input, updatedAt: "2026-04-01T00:00:00.000Z" } as Workflow;
      },
      getWorkflowCurrentProjectID: () => "",
    } as unknown as WorkflowService;

    const opts = defaultApplyOptions();
    opts.directory = path.join(repo, "definitions");
    opts.all = true;
    opts.noLint = true;
    opts.allowDuplicates = true;
    opts.fromGitChanges = true;
    opts.gitDiffSpec = "HEAD~1..HEAD";

    const cwd = process.cwd();
    process.chdir(repo);
    let result: Awaited<ReturnType<Executor["execute"]>>;
    try {
      result = await new Executor(service, opts).execute();
    } finally {
      process.chdir(cwd);
    }

    expect(result.operations[0]?.threeWayUsed).toBe(true);
    expect(result.updateCount).toBe(1);
    expect(declared).toEqual([REMOTE_STAMP]);
  });
});
