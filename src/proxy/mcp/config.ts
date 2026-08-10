/**
 * Turning `--mcp-*` flags (and their env vars) into an {@link McpPolicy}.
 *
 * Kept apart from the gate so a malformed policy is rejected at startup, with a
 * message naming the flag, rather than silently gating nothing at request time.
 *
 * The surface is deliberately small. Three things that could have been options
 * are not:
 *
 *   - the endpoint path — n8n fixes it at `/mcp-server/http`;
 *   - re-checking `settings.availableInMCP` — n8n already refuses those calls;
 *   - fail-open switches for an unreadable workflow list or a call that names
 *     no workflow — a gate that opens on an outage is not a gate, and
 *     `--mcp-enforce warn` already covers "measure, don't block".
 */

import type { EnforceLevel } from "../config.ts";
import type { McpPolicy } from "./policy.ts";

export interface McpGateSettings {
  enforce: EnforceLevel;
  policy: McpPolicy;
  cacheTtlMs: number;
}

export interface McpCliOptions {
  mcpEnforce?: string;
  mcpAllowTools?: string;
  mcpDenyTools?: string;
  mcpWorkflowTags?: string;
  mcpCacheTtlMs?: string;
}

/**
 * Builds the gate settings, or returns null when the operator asked for no gate.
 *
 * The gate is off unless `--mcp-enforce` says otherwise: an existing deployment
 * that merely forwards `/mcp-server/` must not start filtering because it
 * upgraded.
 */
export function parseMcpSettings(
  opts: McpCliOptions,
  env: NodeJS.ProcessEnv,
): McpGateSettings | null {
  const enforceRaw = opts.mcpEnforce ?? env.N8N_MCP_ENFORCE;
  if (!enforceRaw) return null;

  return {
    enforce: parseEnforce(enforceRaw),
    policy: {
      allowTools: parseList(opts.mcpAllowTools ?? env.N8N_MCP_ALLOW_TOOLS),
      denyTools: parseList(opts.mcpDenyTools ?? env.N8N_MCP_DENY_TOOLS),
      workflowTags: parseList(opts.mcpWorkflowTags ?? env.N8N_MCP_WORKFLOW_TAGS),
    },
    cacheTtlMs: parseTtl(opts.mcpCacheTtlMs ?? env.N8N_MCP_CACHE_TTL_MS),
  };
}

function parseEnforce(value: string): EnforceLevel {
  if (value === "off" || value === "warn" || value === "error") return value;
  throw new Error(`Invalid --mcp-enforce value: "${value}" (expected off, warn, or error)`);
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function parseTtl(value: string | undefined): number {
  if (!value) return 60_000;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --mcp-cache-ttl-ms: "${value}" (expected a non-negative integer)`);
  }
  return Number.parseInt(value, 10);
}
