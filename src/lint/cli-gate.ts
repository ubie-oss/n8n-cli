import type { Workflow, WorkflowInput } from "@/api/types.ts";
import {
  checkWorkflowForWrite,
  formatViolationLine,
  LintConfigLoadError,
  prepareWriteLintContext,
} from "./write-check.ts";

/** Arguments accepted by `runPreWriteLintGate`. */
export interface PreWriteLintGateOptions {
  /** Display label for the workflow source (file path or `-` for stdin). */
  source: string;
  /** Parsed workflow payload about to be written. */
  workflow: Workflow | WorkflowInput;
  /** When true, bypass the check entirely. Mirrors a `--no-lint` flag. */
  noLint?: boolean;
  /** Optional `.n8nlintrc.json` path; auto-discovered when omitted. */
  configPath?: string;
  /** Rule names to disable for this run. */
  disableRules?: string[];
}

/**
 * CLI-side gate for single-workflow write commands (`workflow create`,
 * `workflow update`).
 *
 * The gate is ON by default and exits the process with code 1 on the first
 * error-level violation, so the API call never fires. Warnings are surfaced
 * but do not block. Pass `noLint: true` to skip.
 *
 * The exit code path is intentional: these commands are leaf actions, not
 * batch runs, so there is no point continuing past a lint failure to compute
 * a "partial" outcome — the caller would just have to re-run anyway.
 */
export function runPreWriteLintGate(options: PreWriteLintGateOptions): void {
  if (options.noLint) return;

  let ctx: ReturnType<typeof prepareWriteLintContext>;
  try {
    ctx = prepareWriteLintContext(options.configPath, options.disableRules);
  } catch (err) {
    if (err instanceof LintConfigLoadError) {
      console.error(`Error: ${err.message}`);
      console.error("Fix the config file, or pass --no-lint to bypass the pre-write check.");
      process.exit(1);
    }
    throw err;
  }
  const result = checkWorkflowForWrite(options.workflow, undefined, ctx);

  const warnings = result.violations.filter((v) => v.severity === "warning");
  if (warnings.length > 0) {
    for (const v of warnings) {
      console.error(formatViolationLine(options.source, v));
    }
  }

  if (!result.hasErrors) return;

  const errors = result.violations.filter((v) => v.severity === "error" || !v.severity);
  console.error(
    `Lint check failed for ${options.source} (${errors.length} error${
      errors.length === 1 ? "" : "s"
    }). The workflow was NOT written upstream.`,
  );
  for (const v of errors) {
    console.error(`  ${formatViolationLine(options.source, v)}`);
  }
  console.error(
    "Run `n8n-cli lint -f <file>` to iterate locally, or pass --no-lint to bypass once.",
  );
  process.exit(1);
}
