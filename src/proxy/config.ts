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
  /**
   * When true, intercept workflow creation and check the upstream for an
   * existing workflow of the same name. Under enforce=error a match returns
   * 409; under enforce=warn an x-n8n-duplicate-warning header is attached.
   */
  warnDuplicates?: boolean;
  /** TTL for the duplicate-name index cache in ms. Default 60_000. */
  duplicateTtlMs?: number;
  /** Total upstream request timeout in ms. Default 30_000. 0 disables. */
  upstreamTimeoutMs?: number;
}

/**
 * Parses a `--listen` value into host/port. Accepts:
 *
 * - `:8080` → host "0.0.0.0", port 8080
 * - `127.0.0.1:8080` → host "127.0.0.1", port 8080
 * - `[::1]:8080` → host "::1", port 8080 (IPv6 in brackets per RFC 3986)
 *
 * Port 0 is allowed and means "ask the OS for an ephemeral port" — used by
 * tests. Trailing garbage in the port (e.g. `:8080abc`) is rejected.
 */
export function parseListenAddr(addr: string): { host: string; port: number } {
  if (!addr.includes(":")) {
    throw new Error(`Invalid --listen address: "${addr}" (expected host:port or :port)`);
  }

  let host: string;
  let portStr: string;

  if (addr.startsWith("[")) {
    // Bracketed IPv6: [::1]:8080
    const closing = addr.indexOf("]");
    if (closing === -1 || addr[closing + 1] !== ":") {
      throw new Error(`Invalid --listen address: "${addr}" (expected [ipv6]:port)`);
    }
    host = addr.slice(1, closing);
    portStr = addr.slice(closing + 2);
  } else {
    const idx = addr.lastIndexOf(":");
    host = idx === 0 ? "0.0.0.0" : addr.slice(0, idx);
    portStr = addr.slice(idx + 1);
  }

  if (!/^\d+$/.test(portStr)) {
    throw new Error(`Invalid port in --listen: "${portStr}" (expected digits only)`);
  }
  const port = Number.parseInt(portStr, 10);
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
