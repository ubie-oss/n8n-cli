import type { Violation } from "@/lint/rules/violation.ts";

/** Action taken on a request, used in audit logs. */
export type LogAction = "pass" | "block" | "warn" | "forward" | "error";

export interface LogEntry {
  ts: string;
  action: LogAction;
  method: string;
  path: string;
  status: number;
  upstreamMs?: number;
  violations?: Array<Pick<Violation, "rule" | "severity" | "message">>;
  workflowName?: string;
  message?: string;
  /**
   * Who the decision was about. Present once an auth middleware has verified
   * an identity — a policy log that doesn't say who was judged can't answer
   * the question anyone actually asks of it.
   */
  identity?: string;
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

export class Logger {
  constructor(private format: LogFormat = "text") {}

  log(entry: Omit<LogEntry, "ts">): void {
    const full: LogEntry = { ts: new Date().toISOString(), ...entry };
    if (this.format === "json") {
      process.stdout.write(`${JSON.stringify(full)}\n`);
    } else {
      // Name the rules, not just the count. Under `enforce: warn` the whole
      // point of the log line is to say which policy would have refused, and a
      // bare number cannot distinguish "denied" from "the lookup failed".
      const v = full.violations?.length
        ? ` violations=${full.violations.length}[${[...new Set(full.violations.map((x) => x.rule))].join(",")}]`
        : "";
      const ms = full.upstreamMs !== undefined ? ` upstreamMs=${full.upstreamMs}` : "";
      const wf = full.workflowName ? ` workflow="${full.workflowName}"` : "";
      const msg = full.message ? ` msg="${full.message}"` : "";
      const who = full.identity ? ` identity="${full.identity}"` : "";
      process.stdout.write(
        `${full.ts} ${full.action.toUpperCase()} ${full.method} ${full.path} ${full.status}${ms}${wf}${who}${v}${msg}\n`,
      );
    }
  }
}
