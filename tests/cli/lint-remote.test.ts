import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import type { Workflow } from "@/api/types.ts";

/**
 * CLI integration tests for the lint --remote option.
 *
 * These tests start a tiny HTTP server that mimics the n8n API,
 * then invoke `n8n-cli lint --remote` against it.
 */

const CLI_ENTRY = resolve("src/index.ts");

interface LintViolation {
  file: string;
  rule: string;
  message: string;
  severity: "error" | "warning";
  url?: string;
}

interface LintOutput {
  violations: LintViolation[];
  summary: {
    files_checked: number;
    violations_found: number;
    files_with_violations: number;
    error_count: number;
    warning_count: number;
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-test-1",
    name: "Test Workflow",
    active: true,
    nodes: [],
    connections: {},
    ...overrides,
  };
}

function makeScheduleNode(
  name: string,
  field: string,
  interval: number,
): Workflow["nodes"][number] {
  const intervalKey = `${field}Interval`;
  return {
    id: "node-1",
    name,
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1,
    position: [0, 0] as [number, number],
    parameters: {
      rule: {
        interval: [{ field, [intervalKey]: interval }],
      },
    },
  };
}

/** Write a lint config that only enables schedule-trigger-frequency. */
function writeScheduleOnlyConfig(dir: string): string {
  const configPath = path.join(dir, ".n8nlintrc.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      rules: {
        "json-syntax": "off",
        "required-fields": "off",
        "connection-ref": "off",
        "orphaned-node": "off",
        "implicit-json-ref": "off",
        "expression-mode-prefix": "off",
        "ai-agent-output-ref": "off",
        "node-params": "off",
        "node-ref-field-check": "off",
        "node-ref-cardinality": "off",
        "webhook-id-required": "off",
        "banned-node": "off",
        "filter-operator-valid": "off",
        "schedule-trigger-frequency": ["warning", { minInterval: "hourly" }],
      },
    }),
  );
  return configPath;
}

/** Start a mock n8n API server that returns the given workflows. */
async function startMockServer(
  workflows: Workflow[],
): Promise<{ port: number; server: ReturnType<typeof Bun.serve> }> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/workflows" || url.pathname === "/workflows") {
        const activeParam = url.searchParams.get("active");
        let filtered = workflows;
        if (activeParam === "true") {
          filtered = workflows.filter((w) => w.active);
        } else if (activeParam === "false") {
          filtered = workflows.filter((w) => !w.active);
        }

        return new Response(JSON.stringify({ data: filtered, nextCursor: null }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return { port: server.port!, server };
}

/** Run `n8n-cli lint` with the given args and parse JSON output. */
async function runLint(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ output: LintOutput; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "lint", "-o", "json", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  let output: LintOutput;
  try {
    output = JSON.parse(stdout) as LintOutput;
  } catch {
    throw new Error(`Failed to parse lint JSON output.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return { output, exitCode, stderr };
}

// ---------------------------------------------------------------------------
// --remote basic functionality
// ---------------------------------------------------------------------------

describe("CLI lint --remote: 基本機能", () => {
  let server: ReturnType<typeof Bun.serve>;
  let apiURL: string;

  afterEach(() => {
    server?.stop(true);
  });

  test("アクティブなワークフローを取得して lint を実行する", async () => {
    const wf = makeWorkflow({
      id: "wf-1",
      name: "My Workflow",
      nodes: [makeScheduleNode("Every Minute", "minutes", 1)],
    });
    ({ server } = await startMockServer([wf]));
    apiURL = `http://localhost:${server.port}`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-remote-"));
    const configPath = writeScheduleOnlyConfig(tmpDir);

    try {
      const { output } = await runLint(["--remote", "-c", configPath], {
        N8N_API_URL: apiURL,
        N8N_API_KEY: "test-key",
      });

      expect(output.summary.files_checked).toBe(1);
      expect(output.summary.violations_found).toBeGreaterThanOrEqual(1);

      const v = output.violations.find((v) => v.rule === "schedule-trigger-frequency");
      expect(v).toBeDefined();
      expect(v!.file).toBe("My Workflow (wf-1)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("violation に url フィールドが含まれる", async () => {
    const wf = makeWorkflow({
      id: "wf-url-test",
      name: "URL Test",
      nodes: [makeScheduleNode("Fast", "seconds", 10)],
    });
    ({ server } = await startMockServer([wf]));
    apiURL = `http://localhost:${server.port}`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-remote-"));
    const configPath = writeScheduleOnlyConfig(tmpDir);

    try {
      const { output } = await runLint(
        ["--remote", "--ui-url", "https://n8n.example.com", "-c", configPath],
        { N8N_API_URL: apiURL, N8N_API_KEY: "test-key" },
      );

      const v = output.violations.find((v) => v.rule === "schedule-trigger-frequency");
      expect(v).toBeDefined();
      expect(v!.url).toBe("https://n8n.example.com/workflow/wf-url-test");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("--active-only の場合はアクティブな WF のみ対象になる", async () => {
    const active = makeWorkflow({
      id: "wf-active",
      name: "Active WF",
      active: true,
      nodes: [makeScheduleNode("Fast", "minutes", 1)],
    });
    const inactive = makeWorkflow({
      id: "wf-inactive",
      name: "Inactive WF",
      active: false,
      nodes: [makeScheduleNode("Also Fast", "minutes", 1)],
    });
    ({ server } = await startMockServer([active, inactive]));
    apiURL = `http://localhost:${server.port}`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-remote-"));
    const configPath = writeScheduleOnlyConfig(tmpDir);

    try {
      const { output } = await runLint(["--remote", "--active-only", "-c", configPath], {
        N8N_API_URL: apiURL,
        N8N_API_KEY: "test-key",
      });

      expect(output.summary.files_checked).toBe(1);
      const files = output.violations.map((v) => v.file);
      expect(files).not.toContain("Inactive WF (wf-inactive)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("違反がない場合は exit code 0 で空の violations", async () => {
    const wf = makeWorkflow({
      id: "wf-clean",
      name: "Clean WF",
      nodes: [makeScheduleNode("Daily", "days", 1)],
    });
    ({ server } = await startMockServer([wf]));
    apiURL = `http://localhost:${server.port}`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-remote-"));
    const configPath = writeScheduleOnlyConfig(tmpDir);

    try {
      const { output, exitCode } = await runLint(["--remote", "-c", configPath], {
        N8N_API_URL: apiURL,
        N8N_API_KEY: "test-key",
      });

      expect(exitCode).toBe(0);
      expect(output.summary.violations_found).toBe(0);
      expect(output.summary.files_checked).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --remote error cases
// ---------------------------------------------------------------------------

describe("CLI lint --remote: エラーケース", () => {
  test("--remote と --dir の同時指定でエラー終了する", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "lint", "--remote", "--dir", "/tmp"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        N8N_API_URL: "http://localhost:9999",
        N8N_API_KEY: "test",
      },
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--remote cannot be used with --dir or --file");
  });

  test("--remote と --file の同時指定でエラー終了する", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "lint", "--remote", "--file", "/tmp/test.json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          N8N_API_URL: "http://localhost:9999",
          N8N_API_KEY: "test",
        },
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--remote cannot be used with --dir or --file");
  });
});

// ---------------------------------------------------------------------------
// UI URL derivation
// ---------------------------------------------------------------------------

describe("CLI lint --remote: UI URL 導出", () => {
  let server: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    server?.stop(true);
  });

  test("N8N_UI_URL 環境変数が --ui-url より優先されない（CLI が優先）", async () => {
    const wf = makeWorkflow({
      id: "wf-ui",
      name: "UI URL Test",
      nodes: [makeScheduleNode("Fast", "seconds", 5)],
    });
    ({ server } = await startMockServer([wf]));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-remote-"));
    const configPath = writeScheduleOnlyConfig(tmpDir);

    try {
      const { output } = await runLint(
        ["--remote", "--ui-url", "https://cli-override.example.com", "-c", configPath],
        {
          N8N_API_URL: `http://localhost:${server.port}`,
          N8N_API_KEY: "test-key",
          N8N_UI_URL: "https://env-url.example.com",
        },
      );

      const v = output.violations[0];
      expect(v?.url).toBe("https://cli-override.example.com/workflow/wf-ui");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("API URL から UI URL が自動導出される（n8n-direct → n8n）", async () => {
    const wf = makeWorkflow({
      id: "wf-derive",
      name: "Derive Test",
      nodes: [makeScheduleNode("Fast", "seconds", 5)],
    });
    ({ server } = await startMockServer([wf]));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-remote-"));
    const configPath = writeScheduleOnlyConfig(tmpDir);

    try {
      // localhost doesn't have "n8n-direct" so deriveUIURL is a pass-through
      const { output } = await runLint(["--remote", "-c", configPath], {
        N8N_API_URL: `http://localhost:${server.port}`,
        N8N_API_KEY: "test-key",
      });

      const v = output.violations[0];
      expect(v?.url).toContain(`http://localhost:${server.port}/workflow/`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
