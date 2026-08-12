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
  mcpEntryPathPattern?: string;
  mcpCacheTtlMs?: string;
}

/**
 * Options that state a *policy* — what an agent may reach.
 *
 * `--mcp-cache-ttl-ms` is deliberately absent: it tunes how often a lookup is
 * repeated, and someone who set only that has expressed no belief about what
 * is exposed. Refusing to start over it would be noise.
 */
const POLICY_OPTIONS: ReadonlyArray<{ cli: keyof McpCliOptions; env: string }> = [
  { cli: "mcpAllowTools", env: "N8N_MCP_ALLOW_TOOLS" },
  { cli: "mcpDenyTools", env: "N8N_MCP_DENY_TOOLS" },
  { cli: "mcpWorkflowTags", env: "N8N_MCP_WORKFLOW_TAGS" },
  { cli: "mcpEntryPathPattern", env: "N8N_MCP_ENTRY_PATH_PATTERN" },
];

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
  if (!enforceRaw) {
    // Off by default is right, but silently discarding a policy someone wrote
    // is not: the deployment would forward `/mcp-server/` unfiltered while its
    // configuration says otherwise, and nothing in the startup line would
    // contradict the belief that the gate is on.
    const orphans = POLICY_OPTIONS.filter(
      ({ cli, env: name }) => opts[cli] !== undefined || env[name] !== undefined,
    ).map(({ env: name }) => name);
    if (orphans.length > 0) {
      throw new Error(
        `MCP policy is configured (${orphans.join(", ")}) but --mcp-enforce / N8N_MCP_ENFORCE is not set, ` +
          "so the gate would be off and the policy ignored. Set it to off, warn or error.",
      );
    }
    return null;
  }

  return {
    enforce: parseEnforce(enforceRaw),
    policy: {
      allowTools: parseList(opts.mcpAllowTools ?? env.N8N_MCP_ALLOW_TOOLS),
      denyTools: parseList(opts.mcpDenyTools ?? env.N8N_MCP_DENY_TOOLS),
      workflowTags: parseList(opts.mcpWorkflowTags ?? env.N8N_MCP_WORKFLOW_TAGS),
      ...parseEntryPathPattern(opts.mcpEntryPathPattern ?? env.N8N_MCP_ENTRY_PATH_PATTERN),
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

/**
 * A `*`-glob, not a regex — the same shape as the tool patterns, and for the
 * same reason: an operator typo must not become a backtracking hazard on a
 * value that arrives from upstream.
 */
function parseEntryPathPattern(value: string | undefined): { entryPathPattern?: string } {
  if (!value || value.trim() === "") return {};
  return { entryPathPattern: value.trim() };
}

function parseTtl(value: string | undefined): number {
  if (!value) return 60_000;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --mcp-cache-ttl-ms: "${value}" (expected a non-negative integer)`);
  }
  return Number.parseInt(value, 10);
}
