import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `.n8nctlrc.json` — the all-in-one configuration file for n8n-cli (and the
 * future `n8nctl` rename; the filename is chosen with that in mind).
 *
 * Two placements are supported and merged, project winning on conflict:
 *
 *   1. User-level:   `$XDG_CONFIG_HOME/n8nctl/config.json`
 *                    (default `~/.config/n8nctl/config.json`) — the right
 *                    home for personal values such as API keys.
 *   2. Project-level: `.n8nctlrc.json` discovered by walking up from the
 *                    working directory — the right home for shared settings
 *                    a team commits to the repository. The legacy lint-only
 *                    `.n8nlintrc.json` is still discovered and treated as if
 *                    its whole content were the `lint` section.
 *
 * Precedence across all sources:
 *
 *   built-in defaults < user file < project file < environment < CLI flags
 *
 * so environment variables (direnv, CI) keep winning over files, and CLI
 * flags keep winning over everything — same contract as before this file
 * existed. String values support `${ENV_VAR}` interpolation so secrets can
 * stay in the environment while the rest of the configuration is versioned;
 * referencing an undefined variable is an error, not a silent empty string.
 */

/** Name of the all-in-one project-level config file. */
export const PROJECT_RC_FILENAME = ".n8nctlrc.json";
/** Legacy lint-only config file, still discovered as a fallback. */
export const LEGACY_LINT_RC_FILENAME = ".n8nlintrc.json";
/** Directory (under XDG_CONFIG_HOME) holding the user-level config file. */
export const USER_RC_DIR = "n8nctl";
/** User-level config filename. */
export const USER_RC_FILENAME = "config.json";

/** Overrides for the `N8NCTL_CONFIG` / `XDG_CONFIG_HOME` / `HOME` lookups. */
export interface LoadRcEnv {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Explicit config path (--config flag); replaces the project layer. */
  configPath?: string;
}

export interface RcApiSection {
  /** n8n API URL. Same value as N8N_API_URL / --api-url. */
  url?: string;
  /**
   * API key. Supports `${ENV_VAR}` interpolation; a literal key in a
   * project-level file triggers a warning (secrets don't belong in git).
   */
  apiKey?: string;
  /** Request timeout, e.g. "30s", "5m", or plain milliseconds. */
  timeout?: string;
  /** Default output format. */
  output?: "json" | "table";
}

export interface RcLintSection {
  /** Rule configs keyed by rule name — same format as `.n8nlintrc.json`. */
  rules?: Record<string, unknown>;
  /** Per-project rule overrides keyed by n8n project ID. */
  projects?: Record<string, { rules?: Record<string, unknown> }>;
}

export interface RcMiddlewaresSection {
  /** Client middleware chain, e.g. ["iap-auth", "api-key-inject"]. */
  client?: string[];
  /** Server middleware chain, e.g. ["lint", "authz"]. */
  server?: string[];
  /**
   * Per-middleware options keyed by middleware name. Keys mirror the
   * camelCase CLI flag names (e.g. "iap-auth": { "audience": ... } uses the
   * schema option names; each factory's documented CLI option keys are
   * accepted). Secret-carrying options keep their CLI restrictions: a raw
   * key is only ever accepted via an env-var reference.
   */
  options?: Record<string, Record<string, unknown>>;
}

export interface RcMcpSection {
  /** MCP gate enforcement level (flag: --mcp-enforce). */
  enforce?: "off" | "warn" | "error";
  /** Glob patterns for the only tools clients may see (flag: --mcp-allow-tools). */
  allowTools?: string[];
  /** Glob patterns for tools to withhold, applied after allowTools (flag: --mcp-deny-tools). */
  denyTools?: string[];
  /** Workflow tags required for workflow-scoped tool calls (flag: --mcp-workflow-tags). */
  workflowTags?: string[];
  /** Entry-trigger path glob a workflow must match (flag: --mcp-entry-path-pattern). */
  entryPathPattern?: string;
  /** Cached workflow allowlist lifetime in ms (flag: --mcp-cache-ttl-ms). */
  cacheTtlMs?: number;
}

export interface RcProxySection {
  listen?: string;
  /** Upstream n8n base URL. Falls back to api.url when omitted. */
  upstream?: string;
  enforce?: "off" | "warn" | "error";
  logFormat?: "text" | "json";
  logIdentity?: boolean;
  allowDuplicates?: boolean;
  /** Rule names to disable. */
  disableRules?: string[];
  /** Server middleware chain (alias of middlewares.server, proxy-scoped). */
  serverMiddlewares?: string[];
  /** Client middleware chain (alias of middlewares.client, proxy-scoped). */
  clientMiddlewares?: string[];
  /** Tag-based scope filter (AND condition). */
  tags?: string[];
  /** Route table lines, same format as --routes. */
  routes?: string[];
  duplicateTtlMs?: number;
  upstreamTimeoutMs?: number;
  /** MCP gate policy (flag family: --mcp-*). */
  mcp?: RcMcpSection;
}

/** The all-in-one configuration file shape. Every section is optional. */
export interface N8nCtlRc {
  api?: RcApiSection;
  lint?: RcLintSection;
  middlewares?: RcMiddlewaresSection;
  proxy?: RcProxySection;
}

/** Where each layer of the merged configuration came from. */
export interface RcSources {
  /** Explicitly requested file (--config / N8NCTL_CONFIG), if any. */
  explicit?: string;
  user?: string;
  project?: string;
}

export interface LoadedRc {
  /** user < project merged, interpolated, unvalidated beyond shape. */
  config: N8nCtlRc;
  sources: RcSources;
}

/** Thrown for a malformed or unresolvable configuration file. */
export class RcError extends Error {
  constructor(
    message: string,
    public readonly source?: string,
  ) {
    super(message);
    this.name = "RcError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const INTERPOLATION_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Non-global variant for membership tests (global regexes carry lastIndex). */
const INTERPOLATION_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/**
 * Recursively expands `${ENV_VAR}` references inside string values. An
 * undefined variable is an error: a silent empty string would quietly
 * produce an empty API URL or header, and the failure the user would see
 * downstream ("API URL is required") would no longer point at the file that
 * caused it.
 */
export function interpolateEnvStrings(
  value: unknown,
  env: NodeJS.ProcessEnv,
  source?: string,
): unknown {
  if (typeof value === "string") {
    return value.replace(INTERPOLATION_PATTERN, (_whole, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        const where = source ? ` (${source})` : "";
        throw new RcError(
          `Configuration references undefined environment variable \${${name}}${where}`,
          source,
        );
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvStrings(item, env, source));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = interpolateEnvStrings(v, env, source);
    }
    return out;
  }
  return value;
}

/**
 * Deep-merges two configuration objects: plain objects merge recursively,
 * arrays and scalars replace wholesale (a CLI/project list overrides the
 * lower layer's list — matching how the existing middleware option merge
 * treats arrays).
 */
export function deepMergeRc(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, ovValue] of Object.entries(override)) {
    if (ovValue === undefined) continue;
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(ovValue)) {
      out[key] = deepMergeRc(baseValue, ovValue);
    } else {
      out[key] = ovValue;
    }
  }
  return out;
}

function assertSectionObject(raw: Record<string, unknown>, key: string, source: string): void {
  if (raw[key] !== undefined && !isPlainObject(raw[key])) {
    throw new RcError(`Invalid "${key}" section${at(source)}: expected an object`, source);
  }
}

function assertStringArray(value: unknown, label: string, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new RcError(`Invalid ${label}${at(source)}: expected an array of strings`, source);
  }
  return value as string[];
}

function at(source?: string): string {
  return source ? ` in ${source}` : "";
}

function asRc(raw: Record<string, unknown>, source: string): N8nCtlRc {
  assertSectionObject(raw, "api", source);
  assertSectionObject(raw, "lint", source);
  assertSectionObject(raw, "middlewares", source);
  assertSectionObject(raw, "proxy", source);

  const rc: N8nCtlRc = raw as N8nCtlRc;
  if (rc.middlewares) {
    const mw = rc.middlewares as Record<string, unknown>;
    assertStringArray(mw.client, "middlewares.client", source);
    assertStringArray(mw.server, "middlewares.server", source);
    if (mw.options !== undefined && !isPlainObject(mw.options)) {
      throw new RcError(
        `Invalid "middlewares.options" section in ${source}: expected an object keyed by middleware name`,
        source,
      );
    }
    if (isPlainObject(mw.options)) {
      for (const [name, section] of Object.entries(mw.options)) {
        if (!isPlainObject(section)) {
          throw new RcError(
            `Invalid middlewares.options["${name}"] in ${source}: expected an object`,
            source,
          );
        }
      }
    }
  }
  if (rc.proxy) {
    const proxy = rc.proxy as Record<string, unknown>;
    for (const listKey of [
      "disableRules",
      "serverMiddlewares",
      "clientMiddlewares",
      "tags",
      "routes",
    ]) {
      if (proxy[listKey] !== undefined) {
        assertStringArray(proxy[listKey], `proxy.${listKey}`, source);
      }
    }
    for (const numKey of ["duplicateTtlMs", "upstreamTimeoutMs"]) {
      const v = proxy[numKey];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        throw new RcError(
          `Invalid proxy.${numKey}${at(source)}: expected a non-negative number`,
          source,
        );
      }
    }
    if (proxy.mcp !== undefined) {
      if (!isPlainObject(proxy.mcp)) {
        throw new RcError(`Invalid "proxy.mcp" section${at(source)}: expected an object`, source);
      }
      const mcp = proxy.mcp;
      for (const listKey of ["allowTools", "denyTools", "workflowTags"]) {
        if (mcp[listKey] !== undefined) {
          assertStringArray(mcp[listKey], `proxy.mcp.${listKey}`, source);
        }
      }
      const enforce = mcp.enforce;
      if (enforce !== undefined && enforce !== "off" && enforce !== "warn" && enforce !== "error") {
        throw new RcError(
          `Invalid proxy.mcp.enforce${at(source)}: expected off, warn, or error`,
          source,
        );
      }
      const ttl = mcp.cacheTtlMs;
      if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0)) {
        throw new RcError(
          `Invalid proxy.mcp.cacheTtlMs${at(source)}: expected a non-negative number`,
          source,
        );
      }
    }
  }
  return rc;
}

function parseRcJson(data: string, source: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RcError(`Failed to parse configuration file ${source}: ${message}`, source);
  }
  if (!isPlainObject(raw)) {
    throw new RcError(`Configuration file ${source} must contain a JSON object`, source);
  }
  return raw;
}

/**
 * Reads one config file and returns its N8nCtlRc view. A legacy
 * `.n8nlintrc.json` is accepted anywhere a project config is expected: its
 * whole content is the `lint` section, so an existing file keeps working
 * unchanged.
 */
export function parseRcFile(filePath: string, env: NodeJS.ProcessEnv): N8nCtlRc {
  let data: string;
  try {
    data = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new RcError(`Cannot read configuration file: ${filePath}`, filePath);
  }
  const raw = parseRcJson(data, filePath);
  const interpolated = interpolateEnvStrings(raw, env, filePath) as Record<string, unknown>;
  if (path.basename(filePath) === LEGACY_LINT_RC_FILENAME) {
    return { lint: interpolated as RcLintSection };
  }
  return asRc(interpolated, filePath);
}

/**
 * Walks up from startDir looking for `.n8nctlrc.json` (preferred) or the
 * legacy `.n8nlintrc.json`. Within one directory the all-in-one name wins;
 * the nearest directory that contains either file wins overall.
 */
export function findProjectRcFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of [PROJECT_RC_FILENAME, LEGACY_LINT_RC_FILENAME]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Resolves the user-level config path: $XDG_CONFIG_HOME/n8nctl/config.json. */
export function findUserRcFile(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(configHome, USER_RC_DIR, USER_RC_FILENAME);
}

/**
 * Loads and merges the user-level and project-level configuration files.
 * Pure: reads the filesystem each call (a couple of small JSON reads per
 * CLI invocation — cheaper than the memoization bugs a cache would invite
 * with changing cwd/env across call sites).
 *
 * Precedence: user file < project file. `configPath` (from --config or
 * N8NCTL_CONFIG) replaces the project layer and wins over both files.
 */
export function loadRc(options: LoadRcEnv = {}): LoadedRc {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const sources: RcSources = {};

  const explicit = options.configPath ?? env.N8NCTL_CONFIG;
  let config: Record<string, unknown> = {};

  const userPath = findUserRcFile(env);
  if (fs.existsSync(userPath)) {
    const user = parseRcFile(userPath, env);
    config = deepMergeRc(config, user as Record<string, unknown>);
    sources.user = userPath;
  }

  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new RcError(
        `Configuration file not found: ${explicit} (set via --config or N8NCTL_CONFIG)`,
        explicit,
      );
    }
    const explicitRc = parseRcFile(explicit, env);
    config = deepMergeRc(config, explicitRc as Record<string, unknown>);
    sources.explicit = explicit;
  } else {
    const projectPath = findProjectRcFile(cwd);
    if (projectPath) {
      const project = parseRcFile(projectPath, env);
      config = deepMergeRc(config, project as Record<string, unknown>);
      sources.project = projectPath;
    }
  }

  return { config: config as N8nCtlRc, sources };
}

/**
 * Warns when a project-level (committed-to-git) config file carries a
 * literal API key. `${ENV_VAR}` values are fine — the secret stays in the
 * environment. The warning goes to stderr and never blocks.
 */
const warnedSecretSources = new Set<string>();
export function warnLiteralSecretsInRc(loaded: LoadedRc): void {
  const source = loaded.sources.project ?? loaded.sources.explicit;
  if (!source) return;
  if (path.basename(source) === LEGACY_LINT_RC_FILENAME) return;
  if (!loaded.config.api?.apiKey) return;
  if (warnedSecretSources.has(source)) return; // loadRc runs per consumer; warn once.
  let raw: unknown;
  try {
    raw = (JSON.parse(fs.readFileSync(source, "utf-8")) as Record<string, unknown>).api;
  } catch {
    return; // Malformed JSON is reported by loadRc.
  }
  const rawApiKey = isPlainObject(raw) ? raw.apiKey : undefined;
  if (typeof rawApiKey === "string" && !INTERPOLATION_REF.test(rawApiKey)) {
    warnedSecretSources.add(source);
    console.error(
      `Warning: ${source} contains a literal api.apiKey. Secrets in project files tend to leak ` +
        'through git history — use "${ENV_VAR}" interpolation or move the key to ' +
        `${findUserRcFile(process.env)} instead.`,
    );
  }
}

/**
 * Applies the `api` section of the merged config to a Config. Called from
 * `resolveConfig` with defaults < file < env < flags ordering intact.
 */
export function applyRcApiSection(
  config: { apiURL: string; apiKey: string; timeoutMs: number; output: "json" | "table" },
  api: RcApiSection | undefined,
): void {
  if (!api) return;
  if (api.url) config.apiURL = api.url;
  if (api.apiKey) config.apiKey = api.apiKey;
  if (api.timeout) {
    const ms = parseRcDuration(api.timeout);
    if (ms !== null) config.timeoutMs = ms;
  }
  if (api.output === "json" || api.output === "table") config.output = api.output;
}

/** Parses "30s" / "5m" / "1000" (ms) — mirrors cli/root.ts parseDuration. */
export function parseRcDuration(s: string): number | null {
  const trimmed = s.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    default:
      return null;
  }
}
