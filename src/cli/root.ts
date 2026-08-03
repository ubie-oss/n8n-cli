import { Command } from "commander";
import { Client } from "../api/client.ts";
import { CredentialService } from "../api/credential-service.ts";
import { DataTableService } from "../api/data-table-service.ts";
import { ExecutionService } from "../api/execution-service.ts";
import { TagService } from "../api/tag-service.ts";
import { WorkflowService } from "../api/workflow-service.ts";
import {
  type Config,
  ConfigError,
  defaultConfig,
  loadFromEnv,
  validate,
} from "../config/config.ts";
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
  /**
   * The egress chain the API client uses, exposed so commands that reach
   * outside `/api/v1` — webhook calls — send the same credentials. Without it
   * those would be the only unauthenticated requests the CLI makes, and a
   * gateway would reject them while every other command worked.
   */
  clientMiddlewares: ClientMiddleware[];
}

/**
 * Builds the egress middleware chain for the API client from
 * `N8N_CLIENT_MIDDLEWARES`. Empty by default, which keeps the direct-to-n8n
 * path byte-identical to before — nothing is registered, nothing runs.
 *
 * Deliberately knows no middleware by name: each factory reads its own
 * configuration off the environment, so authentication stays an opt-in
 * extension rather than something the core request path carries.
 */
function buildEgressChain(): ClientMiddleware[] {
  const enabled = resolveEnabledList({
    env: process.env,
    envVar: "N8N_CLIENT_MIDDLEWARES",
    fallback: DEFAULT_CLIENT_MIDDLEWARE_CHAIN,
  });
  if (enabled.length === 0) return [];

  registerClientBuiltins();
  return buildClientMiddlewares({ enabled, env: process.env });
}

function createContext(config: Config): GlobalContext {
  const clientMiddlewares = buildEgressChain();
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
    .option("-o, --output <format>", "Output format: json, table", "json");

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
 * Resolve config from global options + env vars.
 * Call this inside commands that need API access.
 */
export function resolveConfig(program: Command): Config {
  const opts = program.opts();
  const config = defaultConfig();
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
  return createContext(config);
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
