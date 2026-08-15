import fs from "node:fs";
import path from "node:path";

const CONFIG_FILENAME = ".n8nlintrc.json";

/**
 * Searches for a config file by walking up from startDir to the filesystem root.
 * Returns the first `.n8nlintrc.json` found, or undefined if none exists.
 */
export function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** RuleConfig represents the configuration for a single rule */
export interface RuleConfig {
  enabled: boolean;
  /** "error", "warning", or empty for default */
  severity: string;
  /** Rule-specific options (from array config format) */
  options?: Record<string, unknown>;
}

/** LintConfig represents the linter configuration loaded from .n8nlintrc.json */
export interface LintConfig {
  /** Rule configurations keyed by rule name */
  rulesConfig: Map<string, RuleConfig>;
  /** Additional rule configurations keyed by n8n project ID, then rule name. */
  projectRulesConfig: Map<string, Map<string, RuleConfig>>;
}

interface RawLintConfig {
  rules?: Record<string, unknown>;
  projects?: Record<string, { rules?: Record<string, unknown> }>;
}

function parseRuleConfigValue(name: string, value: unknown): RuleConfig {
  if (typeof value === "boolean") {
    return { enabled: value, severity: "" };
  }
  if (typeof value === "string") {
    switch (value) {
      case "error":
        return { enabled: true, severity: "error" };
      case "warning":
        return { enabled: true, severity: "warning" };
      case "off":
        return { enabled: false, severity: "" };
      default:
        throw new Error(
          `Invalid rule config value for "${name}": "${value}" (expected "error", "warning", or "off")`,
        );
    }
  }
  if (Array.isArray(value)) {
    // Array format: ["error", { option: value }] or ["warning", { option: value }]
    const [severityVal, optionsVal] = value;
    if (typeof severityVal !== "string") {
      throw new Error(
        `Invalid rule config array for "${name}": first element must be a severity string`,
      );
    }
    let enabled: boolean;
    let severity: string;
    switch (severityVal) {
      case "error":
        enabled = true;
        severity = "error";
        break;
      case "warning":
        enabled = true;
        severity = "warning";
        break;
      case "off":
        enabled = false;
        severity = "";
        break;
      default:
        throw new Error(
          `Invalid rule config value for "${name}": "${severityVal}" (expected "error", "warning", or "off")`,
        );
    }
    const options =
      optionsVal && typeof optionsVal === "object" && !Array.isArray(optionsVal)
        ? (optionsVal as Record<string, unknown>)
        : undefined;
    return { enabled, severity, options };
  }
  throw new Error(`Invalid rule config type for "${name}": expected bool, string, or array`);
}

function parseRulesConfig(rawRules: Record<string, unknown> | undefined): Map<string, RuleConfig> {
  const rulesConfig = new Map<string, RuleConfig>();
  for (const [name, value] of Object.entries(rawRules ?? {})) {
    rulesConfig.set(name, parseRuleConfigValue(name, value));
  }
  return rulesConfig;
}

/** Load reads and parses a lint config file. Auto-discovers from CWD if no path given. */
export function loadLintConfig(configPath?: string): LintConfig {
  const defaultConfig: LintConfig = {
    rulesConfig: new Map(),
    projectRulesConfig: new Map(),
  };

  if (!configPath) {
    configPath = findConfigFile(process.cwd());
    if (!configPath) return defaultConfig;
  }

  let data: string;
  try {
    data = fs.readFileSync(configPath, "utf-8");
  } catch {
    // File doesn't exist or can't be read - return defaults
    return defaultConfig;
  }

  const raw = JSON.parse(data) as RawLintConfig;
  const rulesConfig = parseRulesConfig(raw.rules);
  const projectRulesConfig = new Map<string, Map<string, RuleConfig>>();

  if (raw.projects && typeof raw.projects === "object") {
    for (const [projectId, projectConfig] of Object.entries(raw.projects)) {
      if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
        throw new Error(`Invalid project config for "${projectId}": expected an object`);
      }
      projectRulesConfig.set(projectId, parseRulesConfig(projectConfig.rules));
    }
  }

  return { rulesConfig, projectRulesConfig };
}

/** Checks if a rule is enabled in the config. Default: enabled. */
export function isRuleEnabled(config: LintConfig | null, ruleName: string): boolean {
  if (!config) return true;
  const rc = config.rulesConfig.get(ruleName);
  if (rc !== undefined) return rc.enabled;
  return true;
}

/** Returns the configured options for a rule, or undefined if none. */
export function getRuleOptions(
  config: LintConfig | null,
  ruleName: string,
): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const rc = config.rulesConfig.get(ruleName);
  return rc?.options;
}

/** Returns the configured severity for a rule. Empty = use default. */
export function getRuleSeverity(config: LintConfig | null, ruleName: string): string {
  if (!config) return "";
  const rc = config.rulesConfig.get(ruleName);
  if (rc !== undefined) return rc.severity;
  return "";
}
