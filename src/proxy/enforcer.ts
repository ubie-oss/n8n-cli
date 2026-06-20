import type { Workflow } from "@/api/types.ts";
import type { LintConfig } from "@/lint/config.ts";
import { hasErrors, lintWorkflow } from "@/lint/engine.ts";
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
 * - `off`   never blocks; violations are returned for logging only.
 * - `warn`  never blocks; violations are returned (caller may attach a header).
 * - `error` blocks when any error-level violation is found.
 */
export function evaluate(
  workflow: Workflow | null,
  rawJSON: string,
  rules: RuleWithConfig[],
  config: LintConfig | null,
  level: EnforceLevel,
): EnforcementVerdict {
  const violations = lintWorkflow(workflow, rawJSON, rules, config);
  if (level === "off" || level === "warn") {
    return { block: false, violations };
  }
  return { block: hasErrors(violations), violations };
}
