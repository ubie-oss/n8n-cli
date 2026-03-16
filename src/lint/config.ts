import fs from "node:fs";

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
}

/** Load reads and parses a lint config file. Returns default if not found. */
export function loadLintConfig(configPath?: string): LintConfig {
  const defaultConfig: LintConfig = { rulesConfig: new Map() };

  if (!configPath) {
    return defaultConfig;
  }

  let data: string;
  try {
    data = fs.readFileSync(configPath, "utf-8");
  } catch {
    // File doesn't exist or can't be read - return defaults
    return defaultConfig;
  }

  const raw = JSON.parse(data) as { rules?: Record<string, unknown> };
  const rulesConfig = new Map<string, RuleConfig>();

  if (raw.rules && typeof raw.rules === "object") {
    for (const [name, value] of Object.entries(raw.rules)) {
      if (typeof value === "boolean") {
        rulesConfig.set(name, { enabled: value, severity: "" });
      } else if (typeof value === "string") {
        switch (value) {
          case "error":
            rulesConfig.set(name, { enabled: true, severity: "error" });
            break;
          case "warning":
            rulesConfig.set(name, { enabled: true, severity: "warning" });
            break;
          case "off":
            rulesConfig.set(name, { enabled: false, severity: "" });
            break;
          default:
            throw new Error(
              `Invalid rule config value for "${name}": "${value}" (expected "error", "warning", or "off")`,
            );
        }
      } else if (Array.isArray(value)) {
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
        rulesConfig.set(name, { enabled, severity, options });
      } else {
        throw new Error(`Invalid rule config type for "${name}": expected bool, string, or array`);
      }
    }
  }

  return { rulesConfig };
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
