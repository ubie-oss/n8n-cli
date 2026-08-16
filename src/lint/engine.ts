import type { Workflow } from "@/api/types.ts";
import type { LintConfig } from "./config.ts";
import type { RuleWithConfig } from "./registry.ts";
import type { LintContext } from "./rules/rule.ts";
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
 * @param _config Retained for API compatibility; options are pre-resolved in
 *   `enabledRules` so global and project layers can carry different values.
 * @returns Violations with the configured severity applied. Empty when clean.
 */
export function lintWorkflow(
  workflow: Workflow | null,
  rawJSON: string,
  enabledRules: RuleWithConfig[],
  _config: LintConfig | null,
  context?: LintContext,
): Violation[] {
  const violations: Violation[] = [];
  const violationIndex = new Map<string, number>();
  for (const { rule, severity, options } of enabledRules) {
    const found = rule.check(workflow, rawJSON, options, context);
    for (const v of found) {
      const violation = { ...v, severity };
      const key = JSON.stringify({ ...violation, severity: undefined });
      const existingIndex = violationIndex.get(key);
      if (existingIndex === undefined) {
        violationIndex.set(key, violations.length);
        violations.push(violation);
      } else if (severity === "error") {
        // The same finding may be emitted by the global and project layers.
        // Keep one copy and retain the stricter severity.
        violations[existingIndex] = { ...violations[existingIndex]!, severity };
      }
    }
  }
  return violations;
}

/**
 * Returns the number of error-level violations in a list.
 *
 * The `!v.severity` fallback treats unset severities as errors. `lintWorkflow`
 * always sets `severity`, but external callers may pass violations from other
 * sources, so the conservative default is "block unless explicitly downgraded".
 */
export function countErrorViolations(violations: Violation[]): number {
  return violations.filter((v) => v.severity === "error" || !v.severity).length;
}

/** Returns true if any violation is error-level. */
export function hasErrorViolations(violations: Violation[]): boolean {
  return countErrorViolations(violations) > 0;
}
