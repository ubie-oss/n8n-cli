import { Command } from "commander";
import { Client } from "../api/client.ts";
import { CredentialService } from "../api/credential-service.ts";
import { DataTableService } from "../api/data-table-service.ts";
import { ExecutionService } from "../api/execution-service.ts";
import { FolderService } from "../api/folder-service.ts";
import { TagService } from "../api/tag-service.ts";
import { WorkflowService } from "../api/workflow-service.ts";
import {
  type Config,
  ConfigError,
  defaultConfig,
  loadFromEnv,
  validate,
} from "../config/config.ts";
import { applyRcApiSection, type LoadedRc, loadRc, warnLiteralSecretsInRc } from "../config/rc.ts";
import { buildClientMiddlewares } from "../middleware/client-registry.ts";
import {
  DEFAULT_CLIENT_MIDDLEWARE_CHAIN,
  registerClientBuiltins,
} from "../middleware/client-wiring.ts";
import { resolveEnabledList } from "../middleware/registry.ts";
import type { ClientMiddleware } from "../middleware/types.ts";
import { runVersion } from "./commands/version.ts";

export interface GlobalContext {
  config: Config;
  client: Client;
  workflowService: WorkflowService;
  tagService: TagService;
  executionService: ExecutionService;
  credentialService: CredentialService;
  dataTableService: DataTableService;
  folderService: FolderService;
  /**
   * The egress chain the API client uses, exposed so commands that reach
   * outside `/api/v1` — webhook calls and MCP folder lookups — send the same
   * credentials. Without it those would be the only unauthenticated requests
   * the CLI makes, and a gateway would reject them while every other command
   * worked.
   */
  clientMiddlewares: ClientMiddleware[];
}

/**
 * Builds the egress middleware chain for the API client. The chain list and
 * per-middleware options come from (lowest first) `.n8nctlrc.json` files,
 * then environment variables; CLI flags for the global commands don't carry
 * middleware options, so no CLI layer exists here.
 */
function buildEgressChain(rc: LoadedRc): ClientMiddleware[] {
  const enabled = resolveEnabledList({
    env: process.env,
    envVar: "N8N_CLIENT_MIDDLEWARES",
    fileValue: rc.config.middlewares?.client,
    fallback: DEFAULT_CLIENT_MIDDLEWARE_CHAIN,
  });
  if (enabled.length === 0) return [];

  registerClientBuiltins();
  return buildClientMiddlewares({
    enabled,
    env: process.env,
    fileOptions: rc.config.middlewares?.options,
  });
}

function createContext(config: Config, rc: LoadedRc): GlobalContext {
  const clientMiddlewares = buildEgressChain(rc);
  const client = new Client(config.apiURL, config.apiKey, config.timeoutMs, clientMiddlewares);
  return {
    config,
    client,
    clientMiddlewares,
    workflowService: new WorkflowService(client),
    tagService: new TagService(client),
    executionService: new ExecutionService(client),
    credentialService: new CredentialService(client),
    dataTableService: new DataTableService(client),
    folderService: new FolderService(client),
  };
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("n8n-cli")
    .description("Command line interface for n8n workflow management")
    .enablePositionalOptions()
    .option("--api-url <url>", "n8n API URL (env: N8N_API_URL)")
    .option("--api-key <key>", "n8n API key (env: N8N_API_KEY)")
    .option("--timeout <duration>", "Request timeout (default: 30s, env: N8N_API_TIMEOUT)")
    .option("-o, --output <format>", "Output format: json, table", "json")
    .option(
      "--config <path>",
      "Path to the all-in-one config file (.n8nctlrc.json); replaces project-level " +
        "discovery. User-level defaults to ~/.config/n8nctl/config.json (env: N8NCTL_CONFIG)",
    );

  // version command (does not require API config)
  program
    .command("version")
    .description("Show version information")
    .action(() => {
      runVersion();
    });

  return program;
}

/**
 * Loads the merged configuration files for this invocation. Shared by
 * resolveConfig / middleware wiring / lint discovery so every consumer sees
 * the same user < project merge.
 */
export function loadMergedRc(configPath?: string): LoadedRc {
  const rc = loadRc({ configPath });
  warnLiteralSecretsInRc(rc);
  return rc;
}

/**
 * Resolve config from global options + config files + env vars.
 * Precedence: built-in defaults < config files (user < project) < env < CLI flags.
 * Call this inside commands that need API access.
 */
export function resolveConfig(program: Command): Config {
  const opts = program.opts();
  const config = defaultConfig();

  const rc = loadMergedRc(opts.config);
  applyRcApiSection(config, rc.config.api);

  loadFromEnv(config);

  // CLI flags override env vars
  if (opts.apiUrl) config.apiURL = opts.apiUrl;
  if (opts.apiKey) config.apiKey = opts.apiKey;
  if (opts.timeout) {
    const ms = parseDuration(opts.timeout);
    if (ms !== null) {
      config.timeoutMs = ms;
    } else {
      console.error(`Warning: invalid timeout value "${opts.timeout}", using default (30s)`);
    }
  }
  if (opts.output) config.output = opts.output;

  return config;
}

/**
 * Resolve config and create a full context with API client.
 * Validates that API URL and key are set.
 */
export function resolveContext(program: Command): GlobalContext {
  const config = resolveConfig(program);
  try {
    validate(config);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Error: ${e.message}`);
      if (e.hint) console.error(`Hint: ${e.hint}`);
      process.exit(1);
    }
    throw e;
  }
  const rc = loadMergedRc(program.opts().config);
  return createContext(config, rc);
}

/**
 * Parse a duration string like "30s", "5m", "1000" (ms) into milliseconds.
 */
function parseDuration(s: string): number | null {
  const trimmed = s.trim();

  // Pure number → treat as milliseconds
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  if (!match) return null;

  const value = parseFloat(match[1]!);
  const unit = match[2]!;

  switch (unit) {
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
