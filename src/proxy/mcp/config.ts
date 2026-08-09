/**
 * Turning `--mcp-*` flags (and their env vars) into an {@link McpPolicy}.
 *
 * Kept apart from the gate so a malformed policy is rejected at startup, with a
 * message naming the flag, rather than silently gating nothing at request time.
 */

import type { EnforceLevel } from "../config.ts";
import { DEFAULT_WORKFLOW_ID_ARGS, type McpPolicy, type WorkflowIdArgs } from "./policy.ts";

/** Default MCP endpoint of an n8n instance. */
export const DEFAULT_MCP_PATH_PREFIX = "/mcp-server/";

export interface McpGateSettings {
  pathPrefix: string;
  enforce: EnforceLevel;
  policy: McpPolicy;
  onIndexError: "deny" | "allow";
  cacheTtlMs: number;
}

export interface McpCliOptions {
  mcpEnforce?: string;
  mcpPathPrefix?: string;
  mcpAllowTools?: string;
  mcpDenyTools?: string;
  mcpWorkflowTags?: string;
  mcpWorkflowNamePattern?: string;
  mcpRequireAvailableInMcp?: boolean;
  mcpWorkflowIdArgs?: string;
  mcpOnMissingTarget?: string;
  mcpOnIndexError?: string;
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
  const enforce = parseEnforce(enforceRaw);

  const policy: McpPolicy = {
    allowTools: parseList(opts.mcpAllowTools ?? env.N8N_MCP_ALLOW_TOOLS),
    denyTools: parseList(opts.mcpDenyTools ?? env.N8N_MCP_DENY_TOOLS),
    workflowTags: parseList(opts.mcpWorkflowTags ?? env.N8N_MCP_WORKFLOW_TAGS),
    workflowNamePattern: parsePattern(
      opts.mcpWorkflowNamePattern ?? env.N8N_MCP_WORKFLOW_NAME_PATTERN,
    ),
    requireAvailableInMCP:
      opts.mcpRequireAvailableInMcp === true || env.N8N_MCP_REQUIRE_AVAILABLE_IN_MCP === "true",
    workflowIdArgs: parseWorkflowIdArgs(opts.mcpWorkflowIdArgs ?? env.N8N_MCP_WORKFLOW_ID_ARGS),
    onMissingTarget: parseChoice(
      opts.mcpOnMissingTarget ?? env.N8N_MCP_ON_MISSING_TARGET,
      ["deny", "allow"],
      "deny",
      "--mcp-on-missing-target",
    ),
  };

  return {
    pathPrefix: normalizePrefix(opts.mcpPathPrefix ?? env.N8N_MCP_PATH_PREFIX),
    enforce,
    policy,
    onIndexError: parseChoice(
      opts.mcpOnIndexError ?? env.N8N_MCP_ON_INDEX_ERROR,
      ["deny", "allow"],
      "deny",
      "--mcp-on-index-error",
    ),
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

function parsePattern(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new RegExp(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid --mcp-workflow-name-pattern: ${message}`);
  }
  return value;
}

function parseChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  flag: string,
): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${flag} value: "${value}" (expected ${allowed.join(" or ")})`);
}

function parseTtl(value: string | undefined): number {
  if (!value) return 60_000;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --mcp-cache-ttl-ms: "${value}" (expected a non-negative integer)`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Merges an operator-supplied tool → argument map over the built-in one.
 *
 * Additive by design: an operator adding a tool n8n gained since this release
 * should not have to restate the ones already known. Mapping a tool to an empty
 * list removes it from the scope check.
 */
function parseWorkflowIdArgs(value: string | undefined): WorkflowIdArgs {
  if (!value) return DEFAULT_WORKFLOW_ID_ARGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid --mcp-workflow-id-args: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      '--mcp-workflow-id-args expects a JSON object, e.g. {"run_workflow":["workflowId"]}',
    );
  }

  const merged: WorkflowIdArgs = { ...DEFAULT_WORKFLOW_ID_ARGS };
  for (const [tool, args] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new Error(`--mcp-workflow-id-args: "${tool}" must map to an array of strings`);
    }
    if (args.length === 0) {
      delete merged[tool];
      continue;
    }
    merged[tool] = args as string[];
  }
  return merged;
}

function normalizePrefix(value: string | undefined): string {
  if (!value) return DEFAULT_MCP_PATH_PREFIX;
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}
