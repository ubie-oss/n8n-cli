import type { Command } from "commander";
import { parseEnforceLevel } from "@/proxy/config.ts";
import { startProxy } from "@/proxy/server.ts";

interface ProxyOptions {
  listen: string;
  upstream?: string;
  lintConfig?: string;
  enforce: string;
  disableRule?: string[];
  logFormat: string;
  warnDuplicates?: boolean;
  duplicateTtl?: string;
  upstreamTimeout?: string;
}

export function registerProxyCommand(program: Command): void {
  program
    .command("proxy")
    .description(
      "Run a transparent HTTP proxy that intercepts n8n public-API workflow saves and runs lint",
    )
    .option("--listen <addr>", "Address to bind (host:port or :port)", ":8080")
    .option("--upstream <url>", "Upstream n8n base URL (env: N8N_API_URL)")
    .option("-c, --lint-config <path>", "Path to .n8nlintrc.json (auto-discovered if omitted)")
    .option("--enforce <level>", "Enforcement level for workflow saves: off, warn, error", "error")
    .option("--disable-rule <rules...>", "Disable specific rules (can be repeated)")
    .option("--log-format <fmt>", "Log format: text, json", "text")
    .option(
      "--warn-duplicates",
      "Check upstream for an existing workflow of the same name on POST /api/v1/workflows. Under enforce=error a match returns 409; under enforce=warn a warning header is attached.",
    )
    .option(
      "--duplicate-ttl <ms>",
      "TTL (ms) for the cached upstream workflow-name index used by --warn-duplicates",
      "60000",
    )
    .option(
      "--upstream-timeout <ms>",
      "Per-request upstream timeout in milliseconds (0 disables)",
      "30000",
    )
    .action((opts: ProxyOptions) => {
      const upstream = opts.upstream ?? process.env.N8N_API_URL;
      if (!upstream) {
        console.error(
          "Error: --upstream is required (or set N8N_API_URL). Example: --upstream https://n8n.example.com",
        );
        process.exit(1);
      }

      const logFormat = opts.logFormat === "json" ? "json" : "text";
      const enforce = parseEnforceLevel(opts.enforce);
      const duplicateTtlMs = parsePositiveInt(opts.duplicateTtl, "--duplicate-ttl");
      const upstreamTimeoutMs = parsePositiveInt(opts.upstreamTimeout, "--upstream-timeout");

      const handle = startProxy({
        listen: opts.listen,
        upstream,
        lintConfigPath: opts.lintConfig,
        enforce,
        disableRules: opts.disableRule ?? [],
        logFormat,
        warnDuplicates: !!opts.warnDuplicates,
        duplicateTtlMs,
        upstreamTimeoutMs,
      });

      // Friendly startup line on stderr so it never pollutes JSON log streams.
      console.error(
        `n8n-cli proxy listening on ${opts.listen} → ${upstream} (enforce=${enforce}, lint=${
          opts.lintConfig ?? "auto"
        })`,
      );

      const shutdown = async (signal: string) => {
        console.error(`\nReceived ${signal}, shutting down proxy...`);
        await handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error(`Error: ${flag} expects a non-negative integer (got "${value}")`);
    process.exit(1);
  }
  return Number.parseInt(value, 10);
}
