import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";

const CLI_ENTRY = resolve("src/index.ts");

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "node-schema", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("node-schema list", () => {
  test("outputs table by default", async () => {
    const { stdout, exitCode } = await runCli(["list"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found");
    expect(stdout).toContain("NODE TYPE");
    expect(stdout).toContain("n8n-nodes-base.");
  });

  test("outputs JSON with --output json", async () => {
    const { stdout, exitCode } = await runCli(["list", "--output", "json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("nodeType");
    expect(parsed[0]).toHaveProperty("displayName");
    expect(parsed[0]).toHaveProperty("hasCredentials");
  });

  test("filters by --group", async () => {
    const { stdout, exitCode } = await runCli(["list", "--output", "json", "--group", "trigger"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.length).toBeGreaterThan(0);
    for (const node of parsed) {
      expect(node.group).toContain("trigger");
    }
  });
});

describe("node-schema dump", () => {
  test("dumps index to stdout without --type", async () => {
    const { stdout, exitCode } = await runCli(["dump"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("count");
    expect(parsed).toHaveProperty("nodes");
    expect(parsed.count).toBeGreaterThan(0);
  });

  test("dumps specific node to stdout with --type", async () => {
    const { stdout, exitCode } = await runCli(["dump", "--type", "n8n-nodes-base.slack"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.nodeType).toBe("n8n-nodes-base.slack");
    expect(parsed.displayName).toBe("Slack");
    expect(Array.isArray(parsed.properties)).toBe(true);
    expect(parsed.properties.length).toBeGreaterThan(0);
  });

  test("errors on unknown node type", async () => {
    const { stderr, exitCode } = await runCli(["dump", "--type", "n8n-nodes-base.nonexistent"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not found");
  });

  test("dumps to directory with -o", async () => {
    const outDir = resolve("/tmp/n8n-cli-test-dump-" + Date.now());
    try {
      const { exitCode } = await runCli(["dump", "--type", "n8n-nodes-base.slack", "-o", outDir]);
      expect(exitCode).toBe(0);
      expect(existsSync(resolve(outDir, "n8n-nodes-base.slack.json"))).toBe(true);
      expect(existsSync(resolve(outDir, "_index.json"))).toBe(true);

      const nodeFile = await Bun.file(resolve(outDir, "n8n-nodes-base.slack.json")).json();
      expect(nodeFile.nodeType).toBe("n8n-nodes-base.slack");

      const indexFile = await Bun.file(resolve(outDir, "_index.json")).json();
      expect(indexFile.count).toBe(1);
    } finally {
      if (existsSync(outDir)) rmSync(outDir, { recursive: true });
    }
  });
});
