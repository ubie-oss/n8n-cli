import type { Severity } from "./rule.ts";

/** Violation represents a rule violation found during linting */
export interface Violation {
  /** File path where violation was found */
  file?: string;
  /** Line number (1-indexed, 0 if unknown) */
  line?: number;
  /** Column number (1-indexed, 0 if unknown) */
  column?: number;
  /** Rule name that was violated */
  rule: string;
  /** Human-readable error message */
  message: string;
  /** Severity level (error or warning) */
  severity: Severity;
  /** URL to the workflow in n8n UI (remote mode only) */
  url?: string;
}
