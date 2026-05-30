import { errorCount, type LintResult, warningCount } from "./result.ts";

/** Formats lint results as human-readable text */
export function formatText(result: LintResult): string {
  const lines: string[] = [];

  for (const v of result.violations) {
    let location: string;
    if (v.line && v.line > 0) {
      if (v.column && v.column > 0) {
        location = `${v.file ?? "<unknown>"}:${v.line}:${v.column}`;
      } else {
        location = `${v.file ?? "<unknown>"}:${v.line}`;
      }
    } else if (v.file) {
      location = v.file;
    } else {
      location = "<unknown>";
    }

    const severityLabel = v.severity === "warning" ? "warning" : "error";
    lines.push(`${location}: ${severityLabel}[${v.rule}]: ${v.message}`);
    if (v.url) {
      lines.push(`  ${v.url}`);
    }
  }

  lines.push("");

  const errors = errorCount(result);
  const warnings = warningCount(result);

  if (result.violations.length === 0) {
    lines.push(`✓ Checked ${result.filesChecked} files, no violations found`);
  } else if (errors === 0 && warnings > 0) {
    lines.push(
      `⚠ Checked ${result.filesChecked} files, ${warnings} warning(s) found in ${result.filesFailed} files`,
    );
  } else {
    lines.push(
      `✗ Checked ${result.filesChecked} files, ${errors} error(s), ${warnings} warning(s) found in ${result.filesFailed} files`,
    );
  }

  return lines.join("\n");
}
