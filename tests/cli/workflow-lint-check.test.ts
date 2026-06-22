import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import type { Workflow } from "@/api/types.ts";

/**
 * CLI integration tests for `workflow create` and `workflow update` pre-write
 * lint check. The check is ON by default and refuses to call the API when an
 * error-level rule fires; `--no-lint` is the explicit escape hatch.
 *
 * The tests spawn the CLI against a tiny in-process upstream so we can verify
 * that blocked invocations actually skip the upstream call (no captured
 * request), not just that the CLI exited nonzero.
 */

const CLI_ENTRY = resolve("src/index.ts");

interface CapturedRequest {
  method: string;
  pathname: string;
  body: string;
}

function startMockUpstream(): {
  port: number;
  captured: CapturedRequest[];
  stop: () => Promise<void>;
} {
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      captured.push({ method: req.method, pathname: url.pathname, body });
      // Return a minimal workflow response so the CLI prints success.
      return new Response(
        JSON.stringify({
          id: "wf-new",
          name: "Test",
          active: false,
          nodes: [],
          connections: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return {
    port: server.port!,
    captured,
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function brokenWorkflowJson(): Workflow {
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
    // Connection target "MissingNode" is not in nodes — triggers
    // `connection-reference` (default severity: error).
    connections: {
      Start: {
        main: [[{ node: "MissingNode", type: "main", index: 0 }]],
      },
    },
  };
}

function cleanWorkflowJson(): Workflow {
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
  };
}

describe("workflow create/update pre-write lint check", () => {
  let tmpDir: string;
  let upstream: ReturnType<typeof startMockUpstream>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-lint-cli-test-"));
    upstream = startMockUpstream();
  });

  afterEach(async () => {
    await upstream.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("workflow create: blocks broken workflow by default, no upstream call", async () => {
    const file = path.join(tmpDir, "wf.json");
    fs.writeFileSync(file, JSON.stringify(brokenWorkflowJson()));

    const { stderr, exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "create",
      "-f",
      file,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Lint check failed");
    expect(stderr).toContain("connection-reference");
    expect(upstream.captured).toHaveLength(0);
  });

  test("workflow create: --no-lint bypasses the check and reaches upstream", async () => {
    const file = path.join(tmpDir, "wf.json");
    fs.writeFileSync(file, JSON.stringify(brokenWorkflowJson()));

    const { exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "create",
      "-f",
      file,
      "--no-lint",
    ]);

    expect(exitCode).toBe(0);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]?.method).toBe("POST");
  });

  test("workflow create: clean workflow passes without --no-lint", async () => {
    const file = path.join(tmpDir, "wf.json");
    fs.writeFileSync(file, JSON.stringify(cleanWorkflowJson()));

    const { exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "create",
      "-f",
      file,
    ]);

    expect(exitCode).toBe(0);
    expect(upstream.captured).toHaveLength(1);
  });

  test("workflow update: blocks broken workflow by default", async () => {
    const wf = brokenWorkflowJson();
    wf.id = "wf-existing";
    const file = path.join(tmpDir, "wf.json");
    fs.writeFileSync(file, JSON.stringify(wf));

    const { stderr, exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "update",
      "wf-existing",
      "-f",
      file,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Lint check failed");
    expect(upstream.captured).toHaveLength(0);
  });

  test("workflow update: --no-lint bypasses and reaches upstream", async () => {
    const wf = brokenWorkflowJson();
    wf.id = "wf-existing";
    const file = path.join(tmpDir, "wf.json");
    fs.writeFileSync(file, JSON.stringify(wf));

    const { exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "update",
      "wf-existing",
      "-f",
      file,
      "--no-lint",
    ]);

    expect(exitCode).toBe(0);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]?.method).toBe("PUT");
  });

  // Regression test for the variadic-positional collision found in code
  // review. `--lint-disable-rule` is now scalar (comma-separated), so the
  // positional ID is never swallowed even when both are passed.
  test("workflow update: --lint-disable-rule does NOT swallow the positional id", async () => {
    const wf = brokenWorkflowJson();
    wf.id = "wf-from-file";
    const file = path.join(tmpDir, "wf.json");
    fs.writeFileSync(file, JSON.stringify(wf));

    const { exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "update",
      "--lint-disable-rule",
      "connection-reference",
      "wf-intended",
      "-f",
      file,
    ]);

    expect(exitCode).toBe(0);
    expect(upstream.captured).toHaveLength(1);
    // The PUT must target the positional id, not the file id.
    expect(upstream.captured[0]?.pathname).toContain("wf-intended");
    expect(upstream.captured[0]?.pathname).not.toContain("wf-from-file");
  });

  // Regression test for the validate-before-lint raw error. A workflow
  // missing required fields used to surface as a raw stack trace; it now
  // produces a CLI-style `Error: ... workflow ... is required` message.
  test("workflow create: missing-field error is wrapped in a friendly CLI message", async () => {
    const file = path.join(tmpDir, "wf.json");
    // Missing `connections`.
    fs.writeFileSync(file, JSON.stringify({ name: "x", nodes: [] }));

    const { stderr, exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "workflow",
      "create",
      "-f",
      file,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error:");
    expect(stderr).toContain("connections");
    expect(upstream.captured).toHaveLength(0);
  });
});
