import fs from "node:fs";
import path from "node:path";

/** Default list of tags to auto-apply. */
export const DefaultAutoTags: string[] = ["managed-as-code"];

/** Default project ID (can be overridden in CLAUDE.md). */
export const DefaultProjectID = "";

/** CLIConfig represents configuration loaded from CLAUDE.md. */
export interface CLIConfig {
  defaultProjectID: string;
  autoTags: string[];
  yamlEnabled: boolean;
  tsEnabled: boolean;
  externalizeThreshold: number;
}

/** Loads CLI configuration from CLAUDE.md. */
export function loadCLIConfig(): CLIConfig {
  const claudeMDPath = findClaudeMDPath();
  if (!claudeMDPath) {
    return {
      defaultProjectID: DefaultProjectID,
      autoTags: [...DefaultAutoTags],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
  }

  return parseClaudeMD(claudeMDPath);
}

/**
 * Searches for CLAUDE.md in the current directory and parent directories.
 * Returns the path if found, or null if not found.
 */
export function findClaudeMDPath(): string | null {
  let dir: string;
  try {
    dir = process.cwd();
  } catch {
    return null;
  }

  while (true) {
    const claudePath = path.join(dir, "CLAUDE.md");
    try {
      fs.accessSync(claudePath, fs.constants.R_OK);
      return claudePath;
    } catch {
      // Not found, try parent
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Parses CLAUDE.md and extracts CLI configuration. */
export function parseClaudeMD(filePath: string): CLIConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const config: CLIConfig = {
    defaultProjectID: DefaultProjectID,
    autoTags: [...DefaultAutoTags],
    yamlEnabled: false,
    tsEnabled: false,
    externalizeThreshold: 0,
  };

  let inCLISection = false;
  let inTable = false;

  const tableRowRegex = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check for section header
    if (trimmedLine.startsWith("## n8n CLI")) {
      inCLISection = true;
      continue;
    }

    // Check for end of section (new ## header)
    if (inCLISection && trimmedLine.startsWith("## ") && !trimmedLine.startsWith("## n8n CLI")) {
      inCLISection = false;
      continue;
    }

    if (!inCLISection) {
      continue;
    }

    // Skip table header separator
    if (trimmedLine.startsWith("|---") || trimmedLine.startsWith("| ---")) {
      inTable = true;
      continue;
    }

    // Check for table header
    if (trimmedLine.startsWith("| 設定項目") || trimmedLine.startsWith("|設定項目")) {
      inTable = true;
      continue;
    }

    // Parse table rows
    if (inTable && trimmedLine.startsWith("|")) {
      const matches = tableRowRegex.exec(trimmedLine);
      if (matches && matches.length >= 3) {
        const key = (matches[1] ?? "").trim();
        const value = (matches[2] ?? "").trim();

        switch (key) {
          case "デフォルトプロジェクト ID":
          case "Default Project ID":
          case "defaultProjectId":
            if (value && value !== "-") {
              config.defaultProjectID = value;
            }
            break;

          case "自動タグ":
          case "Auto Tags":
          case "autoTags":
            if (value && value !== "-") {
              const tags = value
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t !== "");
              config.autoTags = tags;
            }
            break;

          case "YAML モード":
          case "YAML Mode":
          case "yamlEnabled":
            if (value && value !== "-") {
              config.yamlEnabled = parseBooleanEnabled(value);
            }
            break;

          case "TypeScript モード":
          case "TypeScript Mode":
          case "tsEnabled":
            if (value && value !== "-") {
              config.tsEnabled = parseBooleanEnabled(value);
            }
            break;

          case "外部ファイル化閾値":
          case "Externalize Threshold":
          case "externalizeThreshold":
            if (value && value !== "-") {
              const threshold = parseThreshold(value);
              if (threshold > 0) {
                config.externalizeThreshold = threshold;
              }
            }
            break;
        }
      }
    }
  }

  return config;
}

/**
 * Returns the effective project ID based on precedence:
 * 1. CLI flag (if provided)
 * 2. Environment variable N8N_DEFAULT_PROJECT
 * 3. CLAUDE.md configuration
 * 4. Empty string (no project)
 */
export function getEffectiveProjectID(flagValue: string, config: CLIConfig | null): string {
  if (flagValue) {
    return flagValue;
  }

  const envValue = process.env.N8N_DEFAULT_PROJECT;
  if (envValue) {
    return envValue;
  }

  if (config?.defaultProjectID) {
    return config.defaultProjectID;
  }

  return "";
}

/**
 * Returns the effective auto tags based on precedence:
 * 1. CLAUDE.md configuration
 * 2. Default value
 */
export function getEffectiveAutoTags(config: CLIConfig | null): string[] {
  if (config && config.autoTags.length > 0) {
    return config.autoTags;
  }
  return [...DefaultAutoTags];
}

/**
 * Returns whether YAML mode is enabled based on precedence:
 * 1. --no-yaml flag (explicit disable)
 * 2. --yaml flag (explicit enable)
 * 3. CLAUDE.md configuration
 * 4. Default: disabled
 */
export function getEffectiveYamlEnabled(
  yamlFlag: boolean,
  noYamlFlag: boolean,
  config: CLIConfig | null,
): boolean {
  if (noYamlFlag) {
    return false;
  }
  if (yamlFlag) {
    return true;
  }
  if (config?.yamlEnabled) {
    return true;
  }
  return false;
}

/**
 * Returns whether `.ts` mode is enabled, using the same precedence as YAML:
 * 1. --no-ts flag (explicit disable)
 * 2. --ts flag (explicit enable)
 * 3. CLAUDE.md configuration
 * 4. Default: disabled
 */
export function getEffectiveTsEnabled(
  tsFlag: boolean,
  noTsFlag: boolean,
  config: CLIConfig | null,
): boolean {
  if (noTsFlag) {
    return false;
  }
  if (tsFlag) {
    return true;
  }
  return config?.tsEnabled === true;
}

/**
 * Returns the effective externalize threshold based on precedence:
 * 1. --threshold flag (if provided)
 * 2. CLAUDE.md configuration
 * 3. Default: 3
 */
export function getEffectiveExternalizeThreshold(
  flagValue: number,
  config: CLIConfig | null,
): number {
  const defaultThreshold = 3;

  if (flagValue > 0) {
    return flagValue;
  }

  if (config && config.externalizeThreshold > 0) {
    return config.externalizeThreshold;
  }

  return defaultThreshold;
}

/** Parses a boolean-like value from CLAUDE.md. */
function parseBooleanEnabled(value: string): boolean {
  switch (value.toLowerCase().trim()) {
    case "有効":
    case "enabled":
    case "true":
    case "yes":
    case "1":
    case "on":
      return true;
    default:
      return false;
  }
}

/** Parses an integer threshold value from CLAUDE.md. */
function parseThreshold(value: string): number {
  const trimmed = value.trim();
  let result = 0;
  for (const ch of trimmed) {
    if (ch >= "0" && ch <= "9") {
      result = result * 10 + (ch.charCodeAt(0) - "0".charCodeAt(0));
    } else {
      break;
    }
  }
  return result;
}
