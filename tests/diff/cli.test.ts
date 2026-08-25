import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerDiffCommand, runDiff } from "../../src/cli/commands/diff.ts";

function writeWorkflow(dir: string, name: string, wf: Record<string, unknown>): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(wf));
  return p;
}

function baseWf(): Record<string, unknown> {
  return {
    id: "wf-x",
    name: "CLI test",
    active: false,
    nodes: [
      {
        id: "n1",
        name: "Start",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: {},
  };
}

function fakeProgram(): Command {
  const program = new Command();
  program.option("-o, --output <format>", "output", "json");
  registerDiffCommand(program);
  return program;
}

describe("diff command — exit code contract", () => {
  test("identical files exit 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-cli-"));
    const a = writeWorkflow(dir, "a.json", baseWf());
    const code = await runDiff(
      a,
      a,
      { dir: ".", stat: false, format: "text", includePosition: false },
      fakeProgram(),
    );
    expect(code).toBe(0);
  });

  test("differing files exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-cli-"));
    const a = writeWorkflow(dir, "a.json", baseWf());
    const changed = baseWf();
    changed.active = true;
    const b = writeWorkflow(dir, "b.json", changed);
    const code = await runDiff(
      a,
      b,
      { dir: ".", stat: false, format: "text", includePosition: false },
      fakeProgram(),
    );
    expect(code).toBe(1);
  });

  test("only one file given is an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-cli-"));
    const a = writeWorkflow(dir, "a.json", baseWf());
    await expect(
      runDiff(
        a,
        undefined,
        { dir: ".", stat: false, format: "text", includePosition: false },
        fakeProgram(),
      ),
    ).rejects.toThrow(/both LEFT and RIGHT/);
  });

  test("unsupported format is an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-cli-"));
    const a = writeWorkflow(dir, "a.json", baseWf());
    await expect(
      runDiff(
        a,
        a,
        { dir: ".", stat: false, format: "yaml", includePosition: false },
        fakeProgram(),
      ),
    ).rejects.toThrow(/unsupported --format/);
  });

  test("unreadable input is an error (exit 2 path)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-diff-cli-"));
    const a = writeWorkflow(dir, "a.json", baseWf());
    await expect(
      runDiff(
        a,
        path.join(dir, "missing.json"),
        { dir: ".", stat: false, format: "text", includePosition: false },
        fakeProgram(),
      ),
    ).rejects.toThrow();
  });

  test("command registers on the program", () => {
    const program = fakeProgram();
    expect(program.commands.some((c) => c.name() === "diff")).toBe(true);
  });
});
