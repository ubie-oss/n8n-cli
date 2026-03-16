import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";

/**
 * CLI integration tests for the lint command.
 *
 * These tests invoke the actual CLI entry point via `bun run src/index.ts lint`
 * with `--output json` and assert on the parsed JSON output. This verifies the
 * full pipeline: CLI arg parsing → file loading → rule execution → JSON output.
 */

const CLI_ENTRY = resolve("src/index.ts");
const FIXTURE_DIR = resolve("tests/fixtures");

interface LintViolation {
  file: string;
  rule: string;
  message: string;
  severity: "error" | "warning";
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

/** Run `n8n-cli lint` with the given args and parse JSON output. */
async function runLint(args: string[]): Promise<{ output: LintOutput; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "lint", "-o", "json", ...args], {
    stdout: "pipe",
    stderr: "pipe",
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
  return { output, exitCode };
}

/** Filter violations by rule name. */
function byRule(violations: LintViolation[], rule: string): LintViolation[] {
  return violations.filter((v) => v.rule === rule);
}

// ---------------------------------------------------------------------------
// lint-clean.yaml — should have zero errors
// ---------------------------------------------------------------------------

describe("CLI lint: clean workflow", () => {
  const fixture = resolve(FIXTURE_DIR, "lint-clean.yaml");

  test("exits with code 0 (no errors)", async () => {
    const { exitCode } = await runLint(["-f", fixture]);
    expect(exitCode).toBe(0);
  });

  test("reports 0 errors", async () => {
    const { output } = await runLint(["-f", fixture]);
    expect(output.summary.error_count).toBe(0);
  });

  test("checks exactly 1 file", async () => {
    const { output } = await runLint(["-f", fixture]);
    expect(output.summary.files_checked).toBe(1);
  });

  test("no node-params violations", async () => {
    const { output } = await runLint(["-f", fixture]);
    expect(byRule(output.violations, "node-params")).toHaveLength(0);
  });

  test("no orphaned-node violations", async () => {
    const { output } = await runLint(["-f", fixture]);
    expect(byRule(output.violations, "orphaned-node")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lint-violations.yaml — should detect all intentional violations
// ---------------------------------------------------------------------------

describe("CLI lint: violations workflow", () => {
  const fixture = resolve(FIXTURE_DIR, "lint-violations.yaml");

  test("exits with non-zero code (has errors)", async () => {
    const { exitCode } = await runLint(["-f", fixture]);
    expect(exitCode).not.toBe(0);
  });

  test("reports at least 1 error", async () => {
    const { output } = await runLint(["-f", fixture]);
    expect(output.summary.error_count).toBeGreaterThanOrEqual(1);
  });

  test("checks exactly 1 file", async () => {
    const { output } = await runLint(["-f", fixture]);
    expect(output.summary.files_checked).toBe(1);
  });

  // -- orphaned-node violations --

  test("detects orphaned nodes (8 unconnected nodes)", async () => {
    const { output } = await runLint(["-f", fixture]);
    const orphaned = byRule(output.violations, "orphaned-node");
    expect(orphaned.length).toBe(8);
  });

  // -- node-params: missing required parameters --

  test("detects Code node missing jsCode", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Code Missing jsCode") && x.message.includes("jsCode"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects HTTP Request node missing url", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("HTTP Invalid") && x.message.includes('"url"'),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects HTTP Request node invalid method enum", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) =>
        x.message.includes("HTTP Invalid") &&
        x.message.includes("method") &&
        x.message.includes("INVALID"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Filter node missing conditions", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Filter Empty") && x.message.includes("conditions"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Set v3 node missing assignments", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Set V3 No Assignments") && x.message.includes("assignments"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects AI Agent node missing promptType", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("AI Agent Empty") && x.message.includes("promptType"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects AI Agent node missing text", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("AI Agent Empty") && x.message.includes('"text"'),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Execute Workflow node missing workflowId value", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Execute Workflow No Value") && x.message.includes("workflowId"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Webhook node missing path", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Webhook Invalid") && x.message.includes('"path"'),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Webhook node invalid httpMethod enum", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) =>
        x.message.includes("Webhook Invalid") &&
        x.message.includes("httpMethod") &&
        x.message.includes("TRACE"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  // -- node-params: missing credentials --

  test("detects Slack node missing credentials", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Slack No Creds") && x.message.includes("credentials"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  test("detects Notion node missing credentials", async () => {
    const { output } = await runLint(["-f", fixture]);
    const v = byRule(output.violations, "node-params");
    const match = v.filter(
      (x) => x.message.includes("Notion No Creds") && x.message.includes("credentials"),
    );
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  // -- webhook-id-required --

  test("detects webhook missing webhookId", async () => {
    const { output } = await runLint(["-f", fixture]);
    const webhookErrors = byRule(output.violations, "webhook-id-required");
    expect(webhookErrors.length).toBeGreaterThanOrEqual(1);
    expect(webhookErrors[0]!.severity).toBe("error");
  });

  // -- summary counts --

  test("total violation count matches individual rule counts", async () => {
    const { output } = await runLint(["-f", fixture]);
    const nodeParams = byRule(output.violations, "node-params").length;
    const orphaned = byRule(output.violations, "orphaned-node").length;
    const webhookId = byRule(output.violations, "webhook-id-required").length;
    const others = output.violations.filter(
      (v) => !["node-params", "orphaned-node", "webhook-id-required"].includes(v.rule),
    ).length;
    expect(output.summary.violations_found).toBe(nodeParams + orphaned + webhookId + others);
  });
});

// ---------------------------------------------------------------------------
// Multiple files at once
// ---------------------------------------------------------------------------

describe("CLI lint: multiple files", () => {
  const clean = resolve(FIXTURE_DIR, "lint-clean.yaml");
  const violations = resolve(FIXTURE_DIR, "lint-violations.yaml");

  test("checks both files", async () => {
    const { output } = await runLint(["-f", clean, violations]);
    expect(output.summary.files_checked).toBe(2);
  });

  test("reports violations from the violations file", async () => {
    const { output } = await runLint(["-f", clean, violations]);
    const nodeParams = byRule(output.violations, "node-params");
    expect(nodeParams.length).toBeGreaterThan(0);
  });

  test("files_with_violations is 1 or more (violations file has issues)", async () => {
    const { output } = await runLint(["-f", clean, violations]);
    expect(output.summary.files_with_violations).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// --disable-rule
// ---------------------------------------------------------------------------

describe("CLI lint: --disable-rule", () => {
  const fixture = resolve(FIXTURE_DIR, "lint-violations.yaml");

  test("disabling node-params removes all node-params violations", async () => {
    const { output } = await runLint(["-f", fixture, "--disable-rule", "node-params"]);
    expect(byRule(output.violations, "node-params")).toHaveLength(0);
  });

  test("disabling orphaned-node removes all orphaned-node violations", async () => {
    const { output } = await runLint(["-f", fixture, "--disable-rule", "orphaned-node"]);
    expect(byRule(output.violations, "orphaned-node")).toHaveLength(0);
  });

  test("disabling multiple rules removes both", async () => {
    const { output } = await runLint([
      "-f",
      fixture,
      "--disable-rule",
      "node-params",
      "orphaned-node",
    ]);
    expect(byRule(output.violations, "node-params")).toHaveLength(0);
    expect(byRule(output.violations, "orphaned-node")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// --list-rules
// ---------------------------------------------------------------------------

describe("CLI lint: --list-rules", () => {
  test("lists available rules and exits successfully", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "lint", "--list-rules"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("node-params");
    expect(stdout).toContain("orphaned-node");
  });
});

// ---------------------------------------------------------------------------
// Output format: text (default)
// ---------------------------------------------------------------------------

describe("CLI lint: text output", () => {
  const fixture = resolve(FIXTURE_DIR, "lint-violations.yaml");

  test("default output is text format (not JSON)", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "lint", "-f", fixture], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Text format uses "file: severity[rule]: message" pattern
    expect(stdout).toContain("warning[node-params]");
    // And should NOT be parseable as JSON
    expect(() => JSON.parse(stdout)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// banned-node rule via config file
// ---------------------------------------------------------------------------

describe("CLI lint: banned-node rule", () => {
  const fixture = resolve(FIXTURE_DIR, "lint-banned-node.yaml");
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-banned-node-"));
    configPath = path.join(tmpDir, ".n8nlintrc.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects banned nodes with config", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "banned-node": [
            "error",
            {
              nodes: [
                {
                  type: "n8n-nodes-base.executeCommand",
                  reason: "Security risk: arbitrary command execution",
                },
                { type: "n8n-nodes-base.code", reason: "Use HTTP Request node instead" },
              ],
            },
          ],
        },
      }),
    );
    const { output } = await runLint(["-f", fixture, "-c", configPath]);
    const banned = byRule(output.violations, "banned-node");
    expect(banned.length).toBe(2);
  });

  test("banned-node violations have correct severity from config", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "banned-node": [
            "error",
            {
              nodes: [{ type: "n8n-nodes-base.executeCommand" }],
            },
          ],
        },
      }),
    );
    const { output } = await runLint(["-f", fixture, "-c", configPath]);
    const banned = byRule(output.violations, "banned-node");
    expect(banned.length).toBe(1);
    expect(banned[0]!.severity).toBe("error");
  });

  test("banned-node message includes reason when provided", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "banned-node": [
            "warning",
            {
              nodes: [{ type: "n8n-nodes-base.executeCommand", reason: "Security risk" }],
            },
          ],
        },
      }),
    );
    const { output } = await runLint(["-f", fixture, "-c", configPath]);
    const banned = byRule(output.violations, "banned-node");
    expect(banned.length).toBe(1);
    expect(banned[0]!.message).toContain("Security risk");
    expect(banned[0]!.message).toContain("Run Shell");
    expect(banned[0]!.severity).toBe("warning");
  });

  test("banned-node message omits reason when not provided", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "banned-node": [
            "error",
            {
              nodes: [{ type: "n8n-nodes-base.code" }],
            },
          ],
        },
      }),
    );
    const { output } = await runLint(["-f", fixture, "-c", configPath]);
    const banned = byRule(output.violations, "banned-node");
    expect(banned.length).toBe(1);
    expect(banned[0]!.message).toBe('Node "My Code" uses banned type "n8n-nodes-base.code"');
  });

  test("non-banned nodes are not flagged", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        rules: {
          "banned-node": [
            "error",
            {
              nodes: [{ type: "n8n-nodes-base.ssh" }],
            },
          ],
        },
      }),
    );
    const { output } = await runLint(["-f", fixture, "-c", configPath]);
    const banned = byRule(output.violations, "banned-node");
    expect(banned.length).toBe(0);
  });

  test("no violations without banned-node config", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ rules: {} }));
    const { output } = await runLint(["-f", fixture, "-c", configPath]);
    const banned = byRule(output.violations, "banned-node");
    expect(banned.length).toBe(0);
  });

  test("--list-rules includes banned-node", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "lint", "--list-rules"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("banned-node");
  });
});
