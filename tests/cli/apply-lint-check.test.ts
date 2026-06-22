import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import type { Workflow } from "@/api/types.ts";

/**
 * End-to-end CLI test for `apply` pre-write lint enforcement. Verifies that
 * the `--no-lint` flag flows from the CLI parser into the executor and that
 * the default-on check actually rejects broken workflows.
 *
 * Uses an in-process mock upstream so we can also assert that the API is
 * never hit when lint blocks.
 */

const CLI_ENTRY = resolve("src/index.ts");

interface CapturedRequest {
  method: string;
  pathname: string;
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
      captured.push({ method: req.method, pathname: url.pathname });

      // workflow list (for duplicate-name check) → empty array. The CLI
      // talks to `/api/v1/workflows`; we match the suffix so the mock is
      // independent of the configured base path. We branch on method first
      // so the create POST handler can return a full workflow.
      if (req.method === "GET") {
        return new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "wf-new",
          name: "broken-wf",
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Connection target points at a missing node → triggers connection-reference. */
function brokenWorkflow(): Workflow {
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
  };
}

describe("apply --no-lint flag", () => {
  let tmpDir: string;
  let upstream: ReturnType<typeof startMockUpstream>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-lint-cli-test-"));
    upstream = startMockUpstream();
  });

  afterEach(async () => {
    await upstream.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("default-on lint rejects broken workflow and skips the create call", async () => {
    fs.writeFileSync(path.join(tmpDir, "wf.json"), JSON.stringify(brokenWorkflow()));

    const { stdout, exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "apply",
      "--dir",
      tmpDir,
      "--dangerously-apply-all",
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("lint check failed");
    // The duplicate-name check may pre-list workflows, but no POST should
    // hit /workflows.
    const mutations = upstream.captured.filter((r) => r.method === "POST" || r.method === "PUT");
    expect(mutations).toHaveLength(0);
  });

  test("--no-lint flows through and forwards the broken workflow", async () => {
    fs.writeFileSync(path.join(tmpDir, "wf.json"), JSON.stringify(brokenWorkflow()));

    const { stdout, stderr, exitCode } = await runCli([
      "--api-url",
      `http://127.0.0.1:${upstream.port}`,
      "--api-key",
      "dummy",
      "apply",
      "--dir",
      tmpDir,
      "--dangerously-apply-all",
      "--no-lint",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout + stderr).not.toContain("lint check failed");
    const mutations = upstream.captured.filter((r) => r.method === "POST" || r.method === "PUT");
    expect(mutations.length).toBeGreaterThanOrEqual(1);
  });
});
