import type { Violation } from "@/lint/rules/violation.ts";

export interface LintErrorBody {
  error: "workflow_lint_failed";
  message: string;
  violations: Array<Pick<Violation, "rule" | "severity" | "message" | "line" | "column">>;
  docs: string;
}

const DOCS_URL = "https://github.com/ubie-oss/n8n-cli#lint";

/**
 * Builds a 422 response body advertising the lint failure to the caller.
 *
 * Includes ALL violations (both error and warning) so callers can fix them in
 * a single round-trip rather than discovering warnings only after they fix the
 * blocking errors. The message count refers to error-level violations because
 * those are what actually caused the block.
 */
export function buildLintErrorResponse(violations: Violation[]): Response {
  const errorCount = violations.filter((v) => v.severity === "error" || !v.severity).length;
  const body: LintErrorBody = {
    error: "workflow_lint_failed",
    message: `Workflow violates ${errorCount} linter rule${
      errorCount === 1 ? "" : "s"
    } and was not forwarded to n8n`,
    violations: violations.map((v) => ({
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

/**
 * Builds a 400 response for requests whose body is not valid JSON. The proxy
 * returns this directly rather than forwarding to upstream because n8n would
 * also reject malformed JSON, and a single clear error is friendlier than two
 * layered ones (upstream 400 + proxy lint header).
 */
export function buildBadJSONResponse(parseError: string): Response {
  const body = {
    error: "workflow_invalid_json",
    message: "Request body is not valid JSON; refusing to forward to n8n",
    parseError,
    docs: DOCS_URL,
  };
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a 409 response when a duplicate workflow name is detected upstream. */
export function buildDuplicateResponse(
  workflowName: string,
  upstreamMatches: Array<{ id: string; active: boolean }>,
): Response {
  const body = {
    error: "workflow_duplicate_name",
    message: `A workflow named "${workflowName}" already exists upstream (${upstreamMatches.length} match${
      upstreamMatches.length === 1 ? "" : "es"
    }). Rename locally or update the existing workflow by ID instead of creating a new one.`,
    duplicates: upstreamMatches,
    docs: DOCS_URL,
  };
  return new Response(JSON.stringify(body), {
    status: 409,
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
