import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { extractMiddlewareCliOpts, registerProxyCommand } from "@/cli/commands/proxy.ts";
import { staleWriteFactory } from "@/middleware/builtin/stale-write/factory.ts";

/**
 * The wiring between a declared `--stale-write-*` flag and the factory that
 * reads it.
 *
 * Both halves are easy to get silently wrong: a flag can be declared on the
 * command and never forwarded to the middleware bag (so it does nothing), or
 * forwarded under a key no factory reads. Neither shows up as a failure — the
 * proxy just runs with defaults.
 */

const FLAGS = [
  { flag: "--stale-write-enforce", key: "staleWriteEnforce", value: "error" },
  { flag: "--stale-write-on-missing-base", key: "staleWriteOnMissingBase", value: "deny" },
  { flag: "--stale-write-on-error", key: "staleWriteOnError", value: "allow" },
  { flag: "--stale-write-actions", key: "staleWriteActions", value: "update,tags" },
];

function declaredFlags(): string[] {
  const program = new Command();
  registerProxyCommand(program);
  const proxy = program.commands.find((c) => c.name() === "proxy");
  if (!proxy) throw new Error("proxy command was not registered");
  return proxy.options.map((o) => o.long ?? "");
}

describe("proxy --stale-write-* flags", () => {
  test.each(FLAGS)("$flag is declared on the command", ({ flag }) => {
    expect(declaredFlags()).toContain(flag);
  });

  test("every declared flag is forwarded to the middleware options bag", () => {
    const opts = Object.fromEntries(FLAGS.map((f) => [f.key, f.value]));
    const forwarded = extractMiddlewareCliOpts(opts as never);

    for (const { key, value } of FLAGS) {
      expect(forwarded[key]).toBe(value);
    }
  });

  test("the forwarded bag is what the factory actually reads", () => {
    const opts = Object.fromEntries(FLAGS.map((f) => [f.key, f.value]));
    const forwarded = extractMiddlewareCliOpts(opts as never);

    expect(staleWriteFactory.loadFromCLI(forwarded)).toEqual({
      enforce: "error",
      onMissingBase: "deny",
      onError: "allow",
      actions: ["update", "tags"],
    });
  });

  test("flags the user did not pass are left out entirely", () => {
    expect(extractMiddlewareCliOpts({} as never)).not.toHaveProperty("staleWriteEnforce");
  });
});
