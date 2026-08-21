import type { Violation } from "@/lint/rules/violation.ts";
import type { AuthContext } from "@/middleware/types.ts";

/** Action taken on a request, used in audit logs. */
export type LogAction = "pass" | "block" | "warn" | "forward" | "error";

/** Severity level, derived from `action`. */
export type LogLevel = "info" | "warn" | "error";

/** Which surface of the proxy a request hit. */
export type LogSurface = "rest-write" | "rest-read" | "mcp" | "transparent";

/**
 * Event kind. `request` is the single terminal access-log line per request;
 * `policy` is a supplementary line (e.g. the MCP gate narrowing a listing
 * after the request was already logged as forwarded). Lines of one request
 * share the same `requestId`.
 */
export type LogEvent = "request" | "policy";

/**
 * Fixed marker carried by every n8n-cli proxy log line. This is the key a
 * log-aggregation filter matches to select the whole batch at once, e.g.
 * Cloud Logging: `jsonPayload.logger == "n8n-cli-proxy"`.
 */
export const LOGGER_NAME = "n8n-cli-proxy";

/**
 * How `identity` was resolved. `oauth-verify` / `impersonator-verify` are
 * cryptographically verified; `middleware` (some middleware wrote
 * `ctx.identity`) and `iap-header` (the ambient GCP IAP header) are not.
 */
export type IdentitySource = "oauth-verify" | "impersonator-verify" | "middleware" | "iap-header";

export interface ResolvedLogIdentity {
  identity: string;
  identitySource: IdentitySource;
  identityVerified: boolean;
}

export interface LogEntry {
  ts: string;
  logger: typeof LOGGER_NAME;
  level: LogLevel;
  action: LogAction;
  status: number;
  /** Pinned by the request-scoped child logger; present on every line in practice. */
  event?: LogEvent;
  method?: string;
  path?: string;
  /** Correlation id shared by every log line produced while handling one request. */
  requestId?: string;
  surface?: LogSurface;
  /** Route action ("create", "update", "read", ...), the thing being done. */
  operation?: string;
  upstreamMs?: number;
  workflowId?: string;
  projectId?: string;
  workflowName?: string;
  /** MCP tool name, e.g. "execute_workflow". */
  tool?: string;
  /** MCP JSON-RPC method, e.g. "tools/call". */
  rpc?: string;
  violations?: Array<Pick<Violation, "rule" | "severity" | "message">>;
  /** Caller identity. Only emitted when identity logging is enabled. */
  identity?: string;
  identitySource?: IdentitySource;
  identityVerified?: boolean;
  message?: string;
}

const SENSITIVE_HEADERS = new Set(["x-n8n-api-key", "authorization", "cookie"]);

/** Strips secrets from header maps before logging. */
export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "<redacted>" : value;
  });
  return out;
}

export type LogFormat = "text" | "json";

/** Fields a child logger inherits and pins onto every line it emits. */
export interface LogBase {
  event?: LogEvent;
  requestId?: string;
  surface?: LogSurface;
  method?: string;
  path?: string;
  operation?: string;
  workflowId?: string;
  projectId?: string;
}

function levelForAction(action: LogAction): LogLevel {
  if (action === "warn") return "warn";
  if (action === "block" || action === "error") return "error";
  return "info";
}

const DEFAULT_WRITE = (line: string): void => {
  process.stdout.write(line);
};

/**
 * Structured request logger for the proxy.
 *
 * Writes one JSON object per line to stdout in `json` mode, or a compact
 * key=value line in `text` mode. Every line carries `logger: "n8n-cli-proxy"`
 * plus a `level` derived from the outcome `action`, so the whole stream can be
 * filtered as a batch regardless of which code path produced it.
 *
 * `child()` returns a bound logger that pins shared per-request fields
 * (`requestId`, `surface`, `operation`, ...), so call sites only pass what is
 * specific to the line they emit. The writer is injectable for tests.
 */
export class Logger {
  constructor(
    private readonly format: LogFormat = "text",
    private readonly write: (line: string) => void = DEFAULT_WRITE,
    private readonly base: LogBase = {},
  ) {}

  /** Returns a logger that merges `fields` into every line it emits. */
  child(fields: LogBase): Logger {
    return new Logger(this.format, this.write, { ...this.base, ...fields });
  }

  log(entry: Omit<LogEntry, "ts" | "logger" | "level">): void {
    const full: LogEntry = {
      ts: new Date().toISOString(),
      logger: LOGGER_NAME,
      level: levelForAction(entry.action),
      event: entry.event ?? this.base.event ?? "request",
      ...this.base,
      ...entry,
    };
    if (this.format === "json") {
      this.write(`${JSON.stringify(full)}\n`);
      return;
    }

    const surface = full.surface ? ` surface=${full.surface}` : "";
    const operation = full.operation ? ` operation=${full.operation}` : "";
    const event = full.event && full.event !== "request" ? ` event=${full.event}` : "";
    const rid = full.requestId ? ` requestId=${full.requestId}` : "";
    const ms = full.upstreamMs !== undefined ? ` upstreamMs=${full.upstreamMs}` : "";
    const wf = full.workflowName ? ` workflow="${full.workflowName}"` : "";
    const wid = full.workflowId ? ` workflowId=${full.workflowId}` : "";
    const ident = full.identity ? ` identity=${full.identity}` : "";
    const v = full.violations?.length ? ` violations=${full.violations.length}` : "";
    const msg = full.message ? ` msg="${full.message}"` : "";
    this.write(
      `${full.ts} ${full.action.toUpperCase()} ${full.method} ${full.path} ${full.status}${surface}${operation}${event}${rid}${ms}${wid}${wf}${ident}${v}${msg}\n`,
    );
  }
}

/**
 * Resolves the best caller identity for a request log.
 *
 * Priority:
 *   1. `pipeline.auth.effective` — verified by oauth-verify / impersonator-verify.
 *   2. `pipeline.identity` — written by some middleware (source ambiguity kept).
 *   3. `X-Goog-Authenticated-User-Email` — injected by an authenticating gateway
 *      (GCP IAP / GLB) in front of the proxy. Ambient: trusted only when direct
 *      access to the proxy is blocked at the network level.
 *
 * Returns undefined when nothing is resolvable. Callers gate this on the
 * `--log-identity` opt-in so emails never reach logs by default.
 */
const IAP_USER_EMAIL_HEADER = "x-goog-authenticated-user-email";
const IAP_EMAIL_PREFIX = "accounts.google.com:";

export function resolveLogIdentity(
  req: Request | undefined,
  pipeline?: { auth?: AuthContext; identity?: string },
): ResolvedLogIdentity | undefined {
  if (!req) return undefined;

  const effective = pipeline?.auth?.effective;
  if (effective) {
    return {
      identity: effective.email,
      identitySource: effective.layer === "impersonator" ? "impersonator-verify" : "oauth-verify",
      identityVerified: true,
    };
  }

  if (pipeline?.identity) {
    return { identity: pipeline.identity, identitySource: "middleware", identityVerified: false };
  }

  const iapEmail = req.headers.get(IAP_USER_EMAIL_HEADER);
  if (iapEmail) {
    const email = iapEmail.startsWith(IAP_EMAIL_PREFIX)
      ? iapEmail.slice(IAP_EMAIL_PREFIX.length)
      : iapEmail;
    if (email !== "") {
      return { identity: email, identitySource: "iap-header", identityVerified: false };
    }
  }

  return undefined;
}
