import type { Workflow } from "@/api/types.ts";
import type { LintConfig } from "@/lint/config.ts";
import { hasErrorViolations, lintWorkflow } from "@/lint/engine.ts";
import type { RuleWithConfig } from "@/lint/registry.ts";
import type { Violation } from "@/lint/rules/violation.ts";
import type { EnforceLevel } from "./config.ts";

export interface EnforcementVerdict {
  /** Should the request be blocked (not forwarded to upstream)? */
  block: boolean;
  /** All violations regardless of severity. */
  violations: Violation[];
}

/**
 * Runs the linter against a workflow JSON body and decides whether the request
 * should be blocked. The decision policy is:
 *
 * - `off`   skips lint entirely (no CPU cost, no violations returned).
 * - `warn`  never blocks; violations are returned (caller may attach a header).
 * - `error` blocks when any error-level violation is found.
 *
 * Rules are user-supplied (organization policy) and may throw on malformed
 * inputs — defensively catch so a single bad rule cannot crash the request.
 */
export function evaluate(
  workflow: Workflow | null,
  rawJSON: string,
  rules: RuleWithConfig[],
  config: LintConfig | null,
  level: EnforceLevel,
): EnforcementVerdict {
  if (level === "off") {
    return { block: false, violations: [] };
  }

  let violations: Violation[];
  try {
    violations = lintWorkflow(workflow, rawJSON, rules, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    violations = [
      {
        rule: "linter-internal-error",
        severity: "error",
        message: `Linter threw an exception while evaluating this workflow: ${message}`,
      },
    ];
  }

  if (level === "warn") {
    return { block: false, violations };
  }
  return { block: hasErrorViolations(violations), violations };
}
