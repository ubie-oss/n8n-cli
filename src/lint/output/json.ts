import { errorCount, type LintResult, warningCount } from "./result.ts";

interface JSONOutput {
  violations: JSONViolation[];
  summary: JSONSummary;
}

interface JSONViolation {
  file: string;
  line?: number;
  column?: number;
  rule: string;
  message: string;
  severity: string;
  url?: string;
}

interface JSONSummary {
  files_checked: number;
  violations_found: number;
  files_with_violations: number;
  error_count: number;
  warning_count: number;
}

/** Formats lint results as JSON */
export function formatJSON(result: LintResult): string {
  const output: JSONOutput = {
    violations: result.violations.map((v) => {
      const jv: JSONViolation = {
        file: v.file ?? "",
        rule: v.rule,
        message: v.message,
        severity: v.severity === "warning" ? "warning" : "error",
      };
      if (v.line && v.line > 0) jv.line = v.line;
      if (v.column && v.column > 0) jv.column = v.column;
      if (v.url) jv.url = v.url;
      return jv;
    }),
    summary: {
      files_checked: result.filesChecked,
      violations_found: result.violations.length,
      files_with_violations: result.filesFailed,
      error_count: errorCount(result),
      warning_count: warningCount(result),
    },
  };

  return JSON.stringify(output, null, 2);
}
