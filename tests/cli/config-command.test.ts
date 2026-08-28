import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";

/**
 * CLI integration tests for the `config show` / `config check` commands.
 * Spawns the real CLI entry point and verifies the end-to-end behavior:
 * file discovery, user < project merge, `${ENV_VAR}` interpolation, secret
 * masking, and the exit-code contract of `config check`.
 */

const CLI_ENTRY = resolve("src/index.ts");

let tmpDir: string;
let xdgDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-cmd-"));
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-cmd-xdg-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(xdgDir, { recursive: true, force: true });
});

function spawnConfig(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "config", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: tmpDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgDir,
      HOME: xdgDir,
      ...envOverrides,
    },
  });
  return (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();
}

describe("config check", () => {
  test("reports OK for a valid project config and prints its path", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { url: "https://x", apiKey: "${MY_KEY}" } }),
    );
    const { stdout, exitCode } = await spawnConfig(["check"], { MY_KEY: "v" });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/OK project: .*\.n8nctlrc\.json/);
  });

  test("reports OK when no config file exists", async () => {
    const { stdout, exitCode } = await spawnConfig(["check"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/No configuration file found/);
  });

  test("fails with exit code 1 on malformed JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, ".n8nctlrc.json"), "{ nope");
    const { stderr, exitCode } = await spawnConfig(["check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Failed to parse configuration file/);
  });

  test("fails with exit code 1 on an undefined ${VAR} reference", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { apiKey: "${NOT_SET_IN_TEST}" } }),
    );
    const { stderr, exitCode } = await spawnConfig(["check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/\$\{NOT_SET_IN_TEST\}/);
  });
});

describe("config show", () => {
  test("shows sources, masks secrets, and merges user < project", async () => {
    fs.mkdirSync(path.join(xdgDir, "n8nctl"), { recursive: true });
    fs.writeFileSync(
      path.join(xdgDir, "n8nctl", "config.json"),
      JSON.stringify({ api: { url: "https://user", apiKey: "user-secret" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({
        api: { url: "https://project", apiKey: "${MY_KEY}" },
        proxy: { enforce: "warn" },
      }),
    );

    const { stdout, exitCode } = await spawnConfig(["show"], { MY_KEY: "interp-secret" });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      sources: { user?: string; project?: string };
      effective: { apiURL: string; apiKey: string; proxy: { enforce?: string } };
      file: { api?: { apiKey: string } };
    };
    expect(parsed.sources.user).toBeDefined();
    expect(parsed.sources.project).toBeDefined();
    // project wins over user
    expect(parsed.effective.apiURL).toBe("https://project");
    // env-interpolated value flows into the effective config but is masked
    expect(parsed.effective.apiKey).toBe("***");
    // masking applies to the file view too — even the user-level literal
    expect(parsed.file.api?.apiKey).toBe("***");
    expect(stdout).not.toContain("user-secret");
    expect(stdout).not.toContain("interp-secret");
    expect(parsed.effective.proxy.enforce).toBe("warn");
  });

  test("--reveal-secrets shows the effective key unmasked", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { url: "https://x", apiKey: "${MY_KEY}" } }),
    );
    const { stdout, exitCode } = await spawnConfig(["show", "--reveal-secrets"], {
      MY_KEY: "s3cret",
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { effective: { apiKey: string } };
    expect(parsed.effective.apiKey).toBe("s3cret");
  });

  test("env var beats file", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".n8nctlrc.json"),
      JSON.stringify({ api: { url: "https://file" } }),
    );
    const { stdout } = await spawnConfig(["show"], { N8N_API_URL: "https://env" });
    const parsed = JSON.parse(stdout) as { effective: { apiURL: string } };
    expect(parsed.effective.apiURL).toBe("https://env");
  });
});
