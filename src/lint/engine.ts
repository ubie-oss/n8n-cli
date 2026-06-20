import type { Workflow } from "@/api/types.ts";
import { getRuleOptions, type LintConfig } from "./config.ts";
import type { RuleWithConfig } from "./registry.ts";
import type { Violation } from "./rules/violation.ts";

/**
 * Runs all enabled rules against a single workflow already in memory.
 *
 * This is the library entry point used by callers that already hold a parsed
 * workflow (e.g. the proxy server intercepting an API request). For file-based
 * linting use the CLI command which adds I/O and reporting on top of this.
 *
 * @param workflow Parsed workflow, or null if the source could not be parsed.
 *   Rules that operate on rawJSON only (json-syntax) still run when null.
 * @param rawJSON Raw JSON string used by rules that need precise line numbers.
 * @param enabledRules Rules + severities resolved from a config.
 * @param config Lint config used to resolve per-rule options. Pass null for
 *   defaults.
 * @returns Violations with the configured severity applied. Empty when clean.
 */
export function lintWorkflow(
  workflow: Workflow | null,
  rawJSON: string,
  enabledRules: RuleWithConfig[],
  config: LintConfig | null,
): Violation[] {
  const violations: Violation[] = [];
  for (const { rule, severity } of enabledRules) {
    const found = rule.check(workflow, rawJSON, getRuleOptions(config, rule.name));
    for (const v of found) {
      violations.push({ ...v, severity });
    }
  }
  return violations;
}

/** Returns the number of error-level violations in a list. */
export function countErrors(violations: Violation[]): number {
  return violations.filter((v) => v.severity === "error" || !v.severity).length;
}

/** Returns true if any violation is error-level. */
export function hasErrors(violations: Violation[]): boolean {
  return countErrors(violations) > 0;
}
