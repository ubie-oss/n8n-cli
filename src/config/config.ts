/** Config holds the CLI configuration. */
export interface Config {
  apiURL: string;
  apiKey: string;
  timeoutMs: number;
  output: "json" | "table";
}

/** ConfigError represents a configuration error. */
export class ConfigError extends Error {
  constructor(
    public readonly field: string,
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Returns the default configuration. */
export function defaultConfig(): Config {
  return {
    apiURL: "",
    apiKey: "",
    timeoutMs: 30_000,
    output: "json",
  };
}

/**
 * Loads configuration from environment variables.
 * Reads N8N_API_URL, N8N_API_KEY, N8N_API_TIMEOUT from process.env.
 * Does NOT read .env files — direnv handles that in this project.
 */
export function loadFromEnv(config: Config): Config {
  const url = process.env.N8N_API_URL;
  if (url) {
    config.apiURL = url;
  }

  const key = process.env.N8N_API_KEY;
  if (key) {
    config.apiKey = key;
  }

  const timeout = process.env.N8N_API_TIMEOUT;
  if (timeout) {
    const ms = Number.parseInt(timeout, 10);
    if (!Number.isNaN(ms) && ms > 0) {
      config.timeoutMs = ms;
    }
  }

  return config;
}

/**
 * Validates the configuration. Throws ConfigError if invalid.
 *
 * The API key requirement is waived when an egress middleware chain is
 * configured (`N8N_CLIENT_MIDDLEWARES`): a gateway that terminates
 * authentication holds the n8n key itself and injects it upstream, so the
 * caller has none. Demanding one anyway would push operators to park a
 * placeholder — or worse, the real shared key — in every developer's shell.
 */
export function validate(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (!config.apiURL) {
    throw new ConfigError(
      "api-url",
      "API URL is required",
      "Set N8N_API_URL environment variable, use --api-url flag, or set api.url in " +
        ".n8nctlrc.json (or ~/.config/n8nctl/config.json)",
    );
  }
  const hasEgressChain = (env.N8N_CLIENT_MIDDLEWARES ?? "").trim().length > 0;
  if (!config.apiKey && !hasEgressChain) {
    throw new ConfigError(
      "api-key",
      "API key is required",
      "Set N8N_API_KEY environment variable, use --api-key flag, or set api.apiKey " +
        '(e.g. "${MY_KEY}") in .n8nctlrc.json — not needed when N8N_CLIENT_MIDDLEWARES ' +
        "supplies credentials",
    );
  }
}
