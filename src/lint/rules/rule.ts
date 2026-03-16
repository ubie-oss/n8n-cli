import type { Workflow } from "@/api/types.ts";
import type { Violation } from "./violation.ts";

/** Severity represents the severity level of a rule violation */
export type Severity = "error" | "warning";

/** Rule defines the interface that all lint rules must implement */
export interface Rule {
  /** Unique kebab-case identifier for the rule */
  name: string;
  /** Human-readable description of what the rule checks */
  description: string;
  /** Default severity level for violations from this rule */
  defaultSeverity: Severity;
  /**
   * Validates the workflow and returns any violations found.
   * @param workflow Parsed workflow, or null if JSON parsing failed
   * @param rawJSON Raw JSON string for rules that need line number extraction
   */
  check(workflow: Workflow | null, rawJSON: string, options?: Record<string, unknown>): Violation[];
}
