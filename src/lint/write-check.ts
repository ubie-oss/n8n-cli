import type { Workflow, WorkflowInput } from "@/api/types.ts";
import { findConfigFile, type LintConfig, loadLintConfig } from "./config.ts";
import { lintWorkflow } from "./engine.ts";
import type { RuleWithConfig } from "./registry.ts";
import { registerDefaultRules } from "./rules/index.ts";
import type { Violation } from "./rules/violation.ts";

/**
 * Outcome of a pre-write lint check on a single workflow payload.
 *
 * `hasErrors` is the gate that callers use to decide whether to refuse the
 * write. `violations` carries all severities so warnings can be surfaced
 * even when the check passes.
 */
export interface WriteLintCheckResult {
  violations: Violation[];
  hasErrors: boolean;
}

/**
 * Pre-resolved lint context shared across multiple workflows in a single
 * command invocation. Built once by `prepareWriteLintContext` so that config
 * lookup and rule registration are not repeated per file.
 */
export interface WriteLintContext {
  rules: RuleWithConfig[];
  config: LintConfig | null;
  configPath?: string;
}

/**
 * Thrown by `prepareWriteLintContext` when `.n8nlintrc.json` cannot be parsed
 * or has an invalid rule-config entry. Carries the resolved config path so
 * callers can print a friendly message instead of leaking the raw
 * `SyntaxError` / `Error` from the JSON parser.
 *
 * Distinct error class so callers can `instanceof`-check and decide whether
 * to surface the bypass hint (`--no-lint`).
 */
export class LintConfigLoadError extends Error {
  readonly configPath?: string;
  constructor(configPath: string | undefined, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    const where = configPath ? ` (${configPath})` : "";
    super(`Failed to load lint config${where}: ${causeMsg}`);
    this.name = "LintConfigLoadError";
    this.configPath = configPath;
  }
}

/**
 * Builds a write-time lint context: resolves the `.n8nlintrc.json` config and
 * the set of enabled rules. `disableRules` lets callers honour CLI flags such
 * as `--disable-rule`. `startDir` overrides the discovery root (default
 * `process.cwd()`) so batch callers can anchor lookup at e.g. `apply --dir`.
 *
 * Throws `LintConfigLoadError` when the config file exists but is malformed;
 * callers should catch and either surface a friendly error or bail out. We
 * intentionally do NOT swallow the error here — falling back to defaults
 * would silently drop user-defined rule overrides, which is worse than
 * loudly failing.
 */
export function prepareWriteLintContext(
  configPath?: string,
  disableRules?: string[],
  startDir?: string,
): WriteLintContext {
  const resolvedPath = configPath ?? findConfigFile(startDir ?? process.cwd());
  let config: LintConfig | null;
  try {
    config = loadLintConfig(resolvedPath);
  } catch (err) {
    throw new LintConfigLoadError(resolvedPath, err);
  }
  const registry = registerDefaultRules();
  const rules = registry.enabledRulesWithConfig(config, disableRules);
  return { rules, config, configPath: resolvedPath };
}

/**
 * Runs the linter against a workflow about to be written upstream.
 *
 * `rawJSON` is reused as-is when available so line-aware rules can locate
 * offending spans. When the caller only has a parsed workflow (e.g. from
 * `WorkflowInput`) we stringify it as a best-effort fallback.
 *
 * Mirrors the defensive try/catch in `src/proxy/enforcer.ts` so a single
 * misbehaving rule cannot crash the calling command. A thrown rule is
 * downgraded to a synthetic `linter-internal-error` violation: the workflow
 * is still blocked (defensive default), but the apply/CLI command can
 * continue processing other workflows and the user sees an actionable
 * message instead of a stack trace.
 */
export function checkWorkflowForWrite(
  workflow: Workflow | WorkflowInput | null,
  rawJSON: string | undefined,
  ctx: WriteLintContext,
): WriteLintCheckResult {
  const payload = rawJSON ?? (workflow ? JSON.stringify(workflow) : "");
  let violations: Violation[];
  try {
    violations = lintWorkflow(workflow as Workflow | null, payload, ctx.rules, ctx.config);
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
  const hasErrors = violations.some((v) => v.severity === "error" || !v.severity);
  return { violations, hasErrors };
}

/**
 * Formats a single violation as a one-line human-readable message. The shape
 * matches `formatText` in `lint/output/text.ts` minus the trailing summary,
 * so output is consistent whether the user runs `lint` or sees a pre-write
 * failure.
 */
export function formatViolationLine(file: string, v: Violation): string {
  let location: string;
  if (v.line && v.line > 0) {
    if (v.column && v.column > 0) {
      location = `${file}:${v.line}:${v.column}`;
    } else {
      location = `${file}:${v.line}`;
    }
  } else {
    location = file;
  }
  const severityLabel = v.severity === "warning" ? "warning" : "error";
  return `${location}: ${severityLabel}[${v.rule}]: ${v.message}`;
}
