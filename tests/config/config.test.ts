import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CLIConfig,
  DefaultAutoTags,
  DefaultProjectID,
  getEffectiveAutoTags,
  getEffectiveExternalizeThreshold,
  getEffectiveProjectID,
  getEffectiveTsEnabled,
  getEffectiveYamlEnabled,
  parseClaudeMD,
} from "@/config/claude-md.ts";
import { ConfigError, defaultConfig, loadFromEnv, validate } from "@/config/config.ts";

describe("defaultConfig", () => {
  test("returns expected defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.apiURL).toBe("");
    expect(cfg.apiKey).toBe("");
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.output).toBe("json");
  });
});

describe("loadFromEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.N8N_API_URL = process.env.N8N_API_URL;
    savedEnv.N8N_API_KEY = process.env.N8N_API_KEY;
    savedEnv.N8N_API_TIMEOUT = process.env.N8N_API_TIMEOUT;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  test("reads URL from env", () => {
    process.env.N8N_API_URL = "https://example.com";
    const cfg = loadFromEnv(defaultConfig());
    expect(cfg.apiURL).toBe("https://example.com");
  });

  test("reads API key from env", () => {
    process.env.N8N_API_KEY = "test-key";
    const cfg = loadFromEnv(defaultConfig());
    expect(cfg.apiKey).toBe("test-key");
  });

  test("reads timeout from env", () => {
    process.env.N8N_API_TIMEOUT = "5000";
    const cfg = loadFromEnv(defaultConfig());
    expect(cfg.timeoutMs).toBe(5000);
  });

  test("ignores invalid timeout", () => {
    process.env.N8N_API_TIMEOUT = "invalid";
    const cfg = loadFromEnv(defaultConfig());
    expect(cfg.timeoutMs).toBe(30_000);
  });

  test("keeps defaults when env is not set", () => {
    delete process.env.N8N_API_URL;
    delete process.env.N8N_API_KEY;
    delete process.env.N8N_API_TIMEOUT;
    const cfg = loadFromEnv(defaultConfig());
    expect(cfg.apiURL).toBe("");
    expect(cfg.apiKey).toBe("");
    expect(cfg.timeoutMs).toBe(30_000);
  });
});

describe("validate", () => {
  test("passes with valid config", () => {
    const cfg = defaultConfig();
    cfg.apiURL = "https://example.com";
    cfg.apiKey = "test-key";
    expect(() => validate(cfg)).not.toThrow();
  });

  test("throws ConfigError for missing API URL", () => {
    const cfg = defaultConfig();
    cfg.apiKey = "test-key";
    try {
      validate(cfg);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).field).toBe("api-url");
    }
  });

  test("throws ConfigError for missing API key", () => {
    const cfg = defaultConfig();
    cfg.apiURL = "https://example.com";
    try {
      validate(cfg);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).field).toBe("api-key");
    }
  });
});

describe("parseClaudeMD", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-md-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses project ID and auto tags from table", () => {
    const content = `# Project

## n8n CLI 設定

| 設定項目 | 値 |
|----------|-----|
| デフォルトプロジェクト ID | TestProject123 |
| 自動タグ | tag1, tag2 |

## Other section
`;
    const filePath = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(filePath, content);

    const config = parseClaudeMD(filePath);
    expect(config.defaultProjectID).toBe("TestProject123");
    expect(config.autoTags).toEqual(["tag1", "tag2"]);
  });

  test("returns defaults when no CLI section", () => {
    const content = `# Project

## Other Section
Some content here.
`;
    const filePath = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(filePath, content);

    const config = parseClaudeMD(filePath);
    expect(config.defaultProjectID).toBe(DefaultProjectID);
    expect(config.autoTags).toEqual(DefaultAutoTags);
  });

  test("parses YAML mode enabled", () => {
    const content = `## n8n CLI 設定

| 設定項目 | 値 |
|----------|-----|
| YAML モード | 有効 |
`;
    const filePath = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(filePath, content);

    const config = parseClaudeMD(filePath);
    expect(config.yamlEnabled).toBe(true);
  });

  test("parses TypeScript mode enabled", () => {
    const content = `## n8n CLI 設定

| 設定項目 | 値 |
|----------|-----|
| TypeScript モード | 有効 |
`;
    const filePath = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(filePath, content);

    const config = parseClaudeMD(filePath);
    expect(config.tsEnabled).toBe(true);
    expect(config.yamlEnabled).toBe(false);
  });

  test("defaults TypeScript mode to disabled", () => {
    const content = `## n8n CLI 設定

| 設定項目 | 値 |
|----------|-----|
| YAML モード | 有効 |
`;
    const filePath = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(filePath, content);

    expect(parseClaudeMD(filePath).tsEnabled).toBe(false);
  });

  test("parses externalize threshold", () => {
    const content = `## n8n CLI 設定

| 設定項目 | 値 |
|----------|-----|
| 外部ファイル化閾値 | 5 |
`;
    const filePath = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(filePath, content);

    const config = parseClaudeMD(filePath);
    expect(config.externalizeThreshold).toBe(5);
  });
});

describe("getEffectiveProjectID", () => {
  const savedEnv = process.env.N8N_DEFAULT_PROJECT;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.N8N_DEFAULT_PROJECT;
    } else {
      process.env.N8N_DEFAULT_PROJECT = savedEnv;
    }
  });

  test("flag takes precedence", () => {
    process.env.N8N_DEFAULT_PROJECT = "env-project";
    const config: CLIConfig = {
      defaultProjectID: "config-project",
      autoTags: [],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
    expect(getEffectiveProjectID("flag-project", config)).toBe("flag-project");
  });

  test("env takes precedence over config", () => {
    process.env.N8N_DEFAULT_PROJECT = "env-project";
    const config: CLIConfig = {
      defaultProjectID: "config-project",
      autoTags: [],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
    expect(getEffectiveProjectID("", config)).toBe("env-project");
  });

  test("falls back to config", () => {
    delete process.env.N8N_DEFAULT_PROJECT;
    const config: CLIConfig = {
      defaultProjectID: "config-project",
      autoTags: [],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
    expect(getEffectiveProjectID("", config)).toBe("config-project");
  });

  test("returns empty when nothing set", () => {
    delete process.env.N8N_DEFAULT_PROJECT;
    expect(getEffectiveProjectID("", null)).toBe("");
  });
});

describe("getEffectiveAutoTags", () => {
  test("returns config tags", () => {
    const config: CLIConfig = {
      defaultProjectID: "",
      autoTags: ["custom-tag"],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
    expect(getEffectiveAutoTags(config)).toEqual(["custom-tag"]);
  });

  test("returns defaults when no config", () => {
    expect(getEffectiveAutoTags(null)).toEqual(DefaultAutoTags);
  });
});

describe("getEffectiveYamlEnabled", () => {
  test("--no-yaml disables even when config enables", () => {
    const config: CLIConfig = {
      defaultProjectID: "",
      autoTags: [],
      yamlEnabled: true,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
    expect(getEffectiveYamlEnabled(false, true, config)).toBe(false);
  });

  test("--yaml enables", () => {
    expect(getEffectiveYamlEnabled(true, false, null)).toBe(true);
  });

  test("config enables", () => {
    const config: CLIConfig = {
      defaultProjectID: "",
      autoTags: [],
      yamlEnabled: true,
      tsEnabled: false,
      externalizeThreshold: 0,
    };
    expect(getEffectiveYamlEnabled(false, false, config)).toBe(true);
  });

  test("defaults to disabled", () => {
    expect(getEffectiveYamlEnabled(false, false, null)).toBe(false);
  });
});

describe("getEffectiveExternalizeThreshold", () => {
  test("flag takes precedence", () => {
    const config: CLIConfig = {
      defaultProjectID: "",
      autoTags: [],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 10,
    };
    expect(getEffectiveExternalizeThreshold(5, config)).toBe(5);
  });

  test("config value used when no flag", () => {
    const config: CLIConfig = {
      defaultProjectID: "",
      autoTags: [],
      yamlEnabled: false,
      tsEnabled: false,
      externalizeThreshold: 10,
    };
    expect(getEffectiveExternalizeThreshold(0, config)).toBe(10);
  });

  test("defaults to 3", () => {
    expect(getEffectiveExternalizeThreshold(0, null)).toBe(3);
  });
});

describe("getEffectiveTsEnabled", () => {
  const enabled = { tsEnabled: true } as CLIConfig;
  const disabled = { tsEnabled: false } as CLIConfig;

  test("--no-ts wins over everything else", () => {
    expect(getEffectiveTsEnabled(true, true, enabled)).toBe(false);
    expect(getEffectiveTsEnabled(false, true, enabled)).toBe(false);
  });

  test("--ts enables it even when the config is silent", () => {
    expect(getEffectiveTsEnabled(true, false, null)).toBe(true);
    expect(getEffectiveTsEnabled(true, false, disabled)).toBe(true);
  });

  test("falls back to the config when no flag is given", () => {
    expect(getEffectiveTsEnabled(false, false, enabled)).toBe(true);
    expect(getEffectiveTsEnabled(false, false, disabled)).toBe(false);
  });

  test("defaults to disabled with neither flag nor config", () => {
    expect(getEffectiveTsEnabled(false, false, null)).toBe(false);
  });
});
