import type { Command } from "commander";
import { parseMiddlewareList } from "@/middleware/registry.ts";
import { parseEnforceLevel } from "@/proxy/config.ts";
import { startProxy } from "@/proxy/server.ts";

interface ProxyOptions {
  listen: string;
  upstream?: string;
  lintConfig?: string;
  enforce: string;
  disableRule?: string[];
  logFormat: string;
  allowDuplicates?: boolean;
  duplicateTtl?: string;
  upstreamTimeout?: string;
  middleware?: string;
  // Authz middleware options (flat namespace so commander stays happy).
  authzEnforce?: string;
  authzOnError?: string;
  authzIdentitySource?: string;
  authzIdentityName?: string;
  authzIdentityDecode?: string;
  authzIdentityClaim?: string;
  authzGroupsUrl?: string;
  authzGroupsMethod?: string;
  authzGroupsHeaders?: string;
  authzGroupsBody?: string;
  authzGroupsExtract?: string;
  authzGroupsCacheTtlMs?: string;
  authzGroupsTimeoutMs?: string;
  authzWorkflowExtract?: string;
  authzWorkflowStripPrefix?: string;
}

export function registerProxyCommand(program: Command): void {
  program
    .command("proxy")
    .description(
      "Run a transparent HTTP proxy that intercepts n8n public-API workflow saves and runs middleware (lint, authz, ...)",
    )
    .option("--listen <addr>", "Address to bind (host:port or :port)", ":8080")
    .option("--upstream <url>", "Upstream n8n base URL (env: N8N_API_URL)")
    .option("-c, --lint-config <path>", "Path to .n8nlintrc.json (auto-discovered if omitted)")
    .option("--enforce <level>", "Enforcement level for workflow saves: off, warn, error", "error")
    .option("--disable-rule <rules...>", "Disable specific rules (can be repeated)")
    .option("--log-format <fmt>", "Log format: text, json", "text")
    .option(
      "--allow-duplicates",
      "Skip the upstream duplicate-name check on POST /api/v1/workflows (the check is on by default; under enforce=error a match returns 409, under enforce=warn a header is attached)",
    )
    .option("--duplicate-ttl <ms>", "TTL (ms) for the cached upstream workflow-name index", "60000")
    .option(
      "--upstream-timeout <ms>",
      "Per-request upstream timeout in milliseconds (0 disables)",
      "30000",
    )
    .option(
      "--middleware <list>",
      "Comma-separated middleware chain (default: lint; env: N8N_MIDDLEWARES). Example: lint,authz",
    )
    // Authz options — only meaningful when "authz" is in the middleware chain.
    .option("--authz-enforce <level>", "Authz enforcement level: off, warn, error")
    .option("--authz-on-error <mode>", "Behavior when groups API fails: deny, allow")
    .option("--authz-identity-source <kind>", "Where to read identity from: header, env, none")
    .option("--authz-identity-name <name>", "Header or env-var name holding the identity")
    .option("--authz-identity-decode <mode>", "Identity decode strategy: raw, jwt")
    .option("--authz-identity-claim <name>", "JWT claim name (decode=jwt)")
    .option("--authz-groups-url <url>", "Groups API endpoint")
    .option("--authz-groups-method <method>", "HTTP method for groups API", "POST")
    .option("--authz-groups-headers <json>", "Headers (JSON object string)")
    .option(
      "--authz-groups-body <template>",
      "Body template; supports ${env:X} and ${json:identity}",
    )
    .option("--authz-groups-extract <jsonpath>", "JSONPath to extract group ids from response")
    .option("--authz-groups-cache-ttl-ms <ms>", "Identity→groups cache TTL in milliseconds")
    .option("--authz-groups-timeout-ms <ms>", "Groups API HTTP timeout in milliseconds")
    .option(
      "--authz-workflow-extract <jsonpath>",
      "JSONPath to extract allowed-group strings from workflow",
    )
    .option(
      "--authz-workflow-strip-prefix <prefix>",
      "Prefix to strip from each extracted ACL value",
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

      const middlewares = parseMiddlewareList(opts.middleware);

      const handle = startProxy({
        listen: opts.listen,
        upstream,
        lintConfigPath: opts.lintConfig,
        enforce,
        disableRules: opts.disableRule ?? [],
        logFormat,
        allowDuplicates: !!opts.allowDuplicates,
        duplicateTtlMs,
        upstreamTimeoutMs,
        middlewares,
        middlewareCliOptions: extractMiddlewareCliOpts(opts),
      });

      // Friendly startup line on stderr so it never pollutes JSON log streams.
      // The displayed middleware list reflects what was passed via --middleware;
      // when empty, the env-var (N8N_MIDDLEWARES) or default chain wins inside
      // startProxy, so this line just says "(env/default)" to avoid lying about
      // an empty chain.
      const mwDisplay = middlewares.length
        ? middlewares.join(",")
        : (process.env.N8N_MIDDLEWARES ?? "lint (default)");
      console.error(
        `n8n-cli proxy listening on ${opts.listen} → ${upstream} (enforce=${enforce}, middlewares=${mwDisplay})`,
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

/**
 * Strips the `opts` bag down to just the keys middleware factories know
 * how to read. Keeping the projection explicit prevents commander
 * artifacts (`_optionValues`, etc.) from leaking into factory inputs.
 */
function extractMiddlewareCliOpts(opts: ProxyOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (k: keyof ProxyOptions) => {
    if (opts[k] !== undefined) out[k] = opts[k];
  };
  copy("authzEnforce");
  copy("authzOnError");
  copy("authzIdentitySource");
  copy("authzIdentityName");
  copy("authzIdentityDecode");
  copy("authzIdentityClaim");
  copy("authzGroupsUrl");
  copy("authzGroupsMethod");
  copy("authzGroupsHeaders");
  copy("authzGroupsBody");
  copy("authzGroupsExtract");
  copy("authzGroupsCacheTtlMs");
  copy("authzGroupsTimeoutMs");
  copy("authzWorkflowExtract");
  copy("authzWorkflowStripPrefix");
  return out;
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error(`Error: ${flag} expects a non-negative integer (got "${value}")`);
    process.exit(1);
  }
  return Number.parseInt(value, 10);
}
