import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * CLI integration tests for the apply command's scope validation.
 *
 * When no scope-limiting flag (--ids, --from-git-changes, APPLY_FILTER_BY_TAGS)
 * is provided, the --dangerously-apply-all flag must be explicitly passed.
 * This prevents accidental wide applies that affect all workflows.
 *
 * The error message intentionally does NOT mention --dangerously-apply-all
 * to avoid AI agents mechanically adding the flag to bypass the safety check.
 */

const CLI_ENTRY = resolve("src/index.ts");

async function runApply(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      CLI_ENTRY,
      "--api-url",
      "http://localhost:0",
      "--api-key",
      "dummy",
      "apply",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("apply --dangerously-apply-all scope validation", () => {
  test("rejects apply with no scope flags", async () => {
    const { stderr, exitCode } = await runApply(["--dry-run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No scope specified");
  });

  test("error message does NOT reveal the bypass flag", async () => {
    const { stderr } = await runApply(["--dry-run"]);
    expect(stderr).not.toContain("dangerously");
  });

  test("error message guides toward scoped alternatives", async () => {
    const { stderr } = await runApply(["--dry-run"]);
    expect(stderr).toContain("--ids");
    expect(stderr).toContain("--from-git-changes");
  });

  test("rejects apply with only --dir", async () => {
    const { stderr, exitCode } = await runApply(["--dir", "./definitions", "--dry-run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No scope specified");
  });

  test("accepts apply with --ids", async () => {
    const { stderr } = await runApply(["--ids", "123", "--dry-run"]);
    expect(stderr).not.toContain("No scope specified");
  });

  test("accepts apply with --dangerously-apply-all", async () => {
    const { stderr } = await runApply(["--dangerously-apply-all", "--dry-run"]);
    expect(stderr).not.toContain("No scope specified");
  });

  test("accepts apply with APPLY_FILTER_BY_TAGS env", async () => {
    const { stderr } = await runApply(["--dry-run"], { APPLY_FILTER_BY_TAGS: "production" });
    expect(stderr).not.toContain("No scope specified");
  });
});
