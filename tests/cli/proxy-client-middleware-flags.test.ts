import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { extractClientMiddlewareCliOpts, registerProxyCommand } from "@/cli/commands/proxy.ts";

/**
 * A standing guard over the projection that carries client-middleware flags
 * from commander into the factories.
 *
 * `extractClientMiddlewareCliOpts` copies an explicit allow-list, so declaring
 * a `--<middleware>-<option>` flag and forgetting to add it there compiles,
 * ships, and does nothing — the proxy silently runs on defaults, and the
 * operator's evidence is a 401 somewhere far away. Rather than list the flags
 * again here (a list that would drift the same way), this derives them from the
 * command itself: every declared flag whose name belongs to a client middleware
 * must survive the projection.
 */

/** Prefixes of the client middlewares registered in `client-wiring.ts`. */
const CLIENT_MIDDLEWARE_FLAG_PREFIXES = [
  "--iap-auth-",
  "--api-key-inject-",
  "--webhook-token-inject-",
  "--bearer-token-inject-",
  "--impersonator-token-",
];

function camelize(long: string): string {
  return long.replace(/^--/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function declaredClientMiddlewareFlags(): string[] {
  const program = new Command();
  registerProxyCommand(program);
  const proxy = program.commands.find((c) => c.name() === "proxy");
  if (!proxy) throw new Error("proxy command was not registered");
  return proxy.options
    .map((o) => o.long ?? "")
    .filter((long) => CLIENT_MIDDLEWARE_FLAG_PREFIXES.some((p) => long.startsWith(p)));
}

describe("proxy client-middleware flags", () => {
  test("the command declares the flags this suite is meant to guard", () => {
    // A sanity check on the derivation itself: if the prefixes ever stop
    // matching, every other assertion here would pass vacuously.
    const flags = declaredClientMiddlewareFlags();
    expect(flags.length).toBeGreaterThan(10);
    expect(flags).toContain("--iap-auth-header-name");
    expect(flags).toContain("--bearer-token-inject-rules");
  });

  test("every declared client-middleware flag reaches the options bag", () => {
    const flags = declaredClientMiddlewareFlags();
    const opts = Object.fromEntries(flags.map((f) => [camelize(f), `value-for-${f}`]));

    const forwarded = extractClientMiddlewareCliOpts(opts as never);

    for (const flag of flags) {
      expect(forwarded[camelize(flag)]).toBe(`value-for-${flag}`);
    }
  });

  test("flags the user did not pass are left out entirely", () => {
    expect(extractClientMiddlewareCliOpts({} as never)).toEqual({});
  });
});
