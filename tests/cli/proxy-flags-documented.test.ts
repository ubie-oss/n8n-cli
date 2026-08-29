import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { registerImportCommand } from "@/cli/commands/import.ts";
import { registerProxyCommand } from "@/cli/commands/proxy.ts";

/**
 * The README and the flags have to describe the same proxy.
 *
 * This is not hypothetical tidiness. Twice while the MCP gate was being built,
 * options were renamed or deleted and the README kept documenting them — and a
 * documented flag that no longer exists is worse than an undocumented one,
 * because an operator copies it into a deployment and the process dies at
 * startup with "unknown option". The reverse costs less but hides the very
 * controls the feature exists to offer.
 *
 * Scope is deliberately the `--mcp-*` family rather than every proxy flag:
 * that is the surface under active change, and a check nobody can satisfy gets
 * deleted rather than fixed.
 */

const PREFIX = "--mcp-";

function declaredFlags(): Set<string> {
  const program = new Command();
  registerProxyCommand(program);
  const proxy = program.commands.find((c) => c.name() === "proxy");
  if (!proxy) throw new Error("the proxy command is not registered");
  return new Set(proxy.options.map((o) => o.long ?? "").filter((long) => long.startsWith(PREFIX)));
}

/**
 * Flags the README may legitimately document with the `--mcp-*` prefix even
 * though they are not proxy flags: `import` grew its own `--mcp-token` /
 * `--mcp-strict` family for MCP-backed folder lookups. A documented flag is
 * stale only when it exists on *neither* command.
 */
function importFlags(): Set<string> {
  const program = new Command();
  registerImportCommand(program);
  const imp = program.commands.find((c) => c.name() === "import");
  if (!imp) throw new Error("the import command is not registered");
  return new Set(imp.options.map((o) => o.long ?? "").filter((long) => long.startsWith(PREFIX)));
}

function documentedFlags(): Set<string> {
  const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf-8");
  // Flags appear as `--mcp-foo` or `--mcp-foo <arg>`; take the name only.
  //
  // The whole README is scanned, so naming a removed flag anywhere — including
  // in prose explaining why it was removed — fails this. That is the intent:
  // a reader copies what they see, and there is no rendering that makes
  // "this flag no longer exists" safe to paste into a deployment.
  const found = readme.match(/--mcp-[a-z0-9-]+/g) ?? [];
  return new Set(found);
}

describe("proxy --mcp-* flags and the README", () => {
  test("every documented flag exists (on proxy or import)", () => {
    const declared = new Set([...declaredFlags(), ...importFlags()]);
    const stale = [...documentedFlags()].filter((f) => !declared.has(f));
    expect(stale).toEqual([]);
  });

  test("every flag is documented", () => {
    const documented = documentedFlags();
    const undocumented = [...declaredFlags()].filter((f) => !documented.has(f));
    expect(undocumented).toEqual([]);
  });

  test("each flag names the environment variable it can be set from", () => {
    // The gate is configured by env in every deployment that runs it — a flag
    // whose env var is undocumented is unreachable there.
    const program = new Command();
    registerProxyCommand(program);
    const proxy = program.commands.find((c) => c.name() === "proxy");
    const missing = (proxy?.options ?? [])
      .filter((o) => (o.long ?? "").startsWith(PREFIX))
      .filter((o) => !/env: N8N_MCP_[A-Z_]+/.test(o.description))
      .map((o) => o.long);
    expect(missing).toEqual([]);
  });
});
