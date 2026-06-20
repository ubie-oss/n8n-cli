/** Enforce levels: off = log only, warn = forward + log violations, error = block on errors */
export type EnforceLevel = "off" | "warn" | "error";

export interface ProxyConfig {
  /** Address to bind, e.g. ":8080" or "127.0.0.1:8080" */
  listen: string;
  /** Upstream n8n base URL, e.g. "https://n8n.example.com" */
  upstream: string;
  /** Optional path to .n8nlintrc.json (auto-discovered if omitted) */
  lintConfigPath?: string;
  /** Enforcement level */
  enforce: EnforceLevel;
  /** Rule names to disable */
  disableRules: string[];
  /** Log format */
  logFormat: "text" | "json";
}

/** Parses a `--listen` value like ":8080" or "127.0.0.1:8080" into host/port. */
export function parseListenAddr(addr: string): { host: string; port: number } {
  if (!addr.includes(":")) {
    throw new Error(`Invalid --listen address: "${addr}" (expected host:port or :port)`);
  }
  const idx = addr.lastIndexOf(":");
  const host = idx === 0 ? "0.0.0.0" : addr.slice(0, idx);
  const portStr = addr.slice(idx + 1);
  const port = Number.parseInt(portStr, 10);
  // Port 0 is allowed and means "ask the OS for an ephemeral port" — used by tests.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port in --listen: "${portStr}"`);
  }
  return { host, port };
}

/** Normalizes upstream URL by stripping a trailing slash. */
export function normalizeUpstream(upstream: string): string {
  return upstream.replace(/\/+$/, "");
}

/** Validates an enforce level string. */
export function parseEnforceLevel(value: string): EnforceLevel {
  if (value === "off" || value === "warn" || value === "error") return value;
  throw new Error(`Invalid --enforce value: "${value}" (expected off, warn, or error)`);
}
