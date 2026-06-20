import type { Violation } from "@/lint/rules/violation.ts";

export interface LintErrorBody {
  error: "workflow_lint_failed";
  message: string;
  violations: Array<Pick<Violation, "rule" | "severity" | "message" | "line" | "column">>;
  docs: string;
}

const DOCS_URL = "https://github.com/ubie-oss/n8n-cli#lint";

/** Builds a 422 response body advertising the lint failure to the caller. */
export function buildLintErrorResponse(violations: Violation[]): Response {
  const errorViolations = violations.filter((v) => v.severity === "error" || !v.severity);
  const body: LintErrorBody = {
    error: "workflow_lint_failed",
    message: `Workflow violates ${errorViolations.length} linter rule${
      errorViolations.length === 1 ? "" : "s"
    } and was not forwarded to n8n`,
    violations: errorViolations.map((v) => ({
      rule: v.rule,
      severity: v.severity,
      message: v.message,
      line: v.line,
      column: v.column,
    })),
    docs: DOCS_URL,
  };
  return new Response(JSON.stringify(body), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a generic 500 response for unexpected proxy failures. */
export function buildErrorResponse(message: string): Response {
  return new Response(JSON.stringify({ error: "proxy_error", message }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}
