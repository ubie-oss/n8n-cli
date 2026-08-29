import type { RcMcpClientSection } from "./rc.ts";

/**
 * Resolved settings for the CLI acting as an MCP *client* — used by `import`
 * to read workflow→folder assignments, which the public REST API cannot
 * report (`parentFolderId` is write-only).
 */
export interface McpClientSettings {
  /** Whether MCP calls should be made at all. */
  enabled: boolean;
  /** MCP access token; absent in proxy mode where the proxy injects one. */
  token?: string;
  /** How the decision was reached — surfaced in help output and warnings. */
  mode: "off" | "direct" | "proxy";
  /** Fail the command when MCP calls fail, instead of warning and continuing. */
  strict: boolean;
}

export interface ResolveMcpClientSettingsInput {
  /** `--mcp` was passed. */
  flagEnabled?: boolean;
  /** `--mcp-token <token>` was passed. */
  flagToken?: string;
  /** `--mcp-strict` was passed. */
  flagStrict?: boolean;
  /** `mcp` section of `.n8nctlrc.json`. */
  rc?: RcMcpClientSection;
  env?: NodeJS.ProcessEnv;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Resolves MCP client settings with the standard precedence:
 * CLI flags < environment < config file < defaults — here flags and env win
 * over the file, per the rc contract.
 */
export function resolveMcpClientSettings(input: ResolveMcpClientSettingsInput): McpClientSettings {
  const env = input.env ?? process.env;
  const rc = input.rc ?? {};

  const envToken = env.N8N_MCP_TOKEN;
  const token =
    input.flagToken ?? (envToken && envToken.trim() !== "" ? envToken : undefined) ?? rc.token;

  const envEnabled = env.N8N_MCP !== undefined && TRUTHY.has(env.N8N_MCP.trim().toLowerCase());
  const rcEnabled = rc.mode === "direct" || rc.mode === "proxy";

  const enabled = Boolean(input.flagEnabled || token || envEnabled || rcEnabled);

  const strict = Boolean(input.flagStrict || rc.strict);

  let mode: McpClientSettings["mode"] = "off";
  if (enabled) {
    // A token in hand means the CLI authenticates itself; without one, the
    // only way MCP works is through a proxy that injects it on the
    // `/mcp-server/` path.
    mode = token ? "direct" : "proxy";
  }

  return { enabled, ...(token ? { token } : {}), mode, strict };
}
