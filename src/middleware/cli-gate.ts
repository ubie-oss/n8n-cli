import type { Workflow, WorkflowInput } from "@/api/types.ts";
import { formatViolationLine } from "@/lint/write-check.ts";
import { disposePipeline, preparePipeline, runPipeline } from "./pipeline.ts";
import { buildMiddlewares, resolveEnabledList } from "./registry.ts";
import type { PreWriteMiddleware } from "./types.ts";
import { DEFAULT_MIDDLEWARE_CHAIN, registerBuiltins } from "./wiring.ts";

export interface PreWriteGateOptions {
  /** Display label for the workflow source (file path or `-` for stdin). */
  source: string;
  /** Parsed workflow payload about to be written. */
  workflow: Workflow | WorkflowInput;
  /** When true, drop `lint` from the chain. Mirrors a `--no-lint` flag. */
  noLint?: boolean;
  /** Optional `.n8nlintrc.json` path; auto-discovered when omitted. */
  lintConfigPath?: string;
  /** Rule names to disable for this run. */
  lintDisableRules?: string[];
  /** Explicit middleware list (CLI or env-derived); empty falls back to defaults. */
  middlewares?: string[];
  /** Forwarded to each middleware factory's loadFromCLI. */
  middlewareCliOptions?: Record<string, unknown>;
  /** Defaults to process.env. Override in tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Drop-in CLI gate for single-workflow write commands (`workflow create`,
 * `workflow update`).
 *
 * Builds the configured middleware chain, runs prepare(), evaluates the
 * one workflow, and exits with code 1 if any middleware blocks. Warnings
 * print to stderr but don't block. Output mirrors the legacy
 * `runPreWriteLintGate` so existing UX is preserved when only lint is
 * enabled.
 *
 * The exit-code policy is intentional: these commands are leaf actions,
 * not batch runs, so there is no point continuing past a policy failure
 * to compute a partial outcome — the caller would just re-run.
 */
export async function runPreWriteGate(options: PreWriteGateOptions): Promise<void> {
  registerBuiltins();
  const env = options.env ?? process.env;
  const enabled = resolveEnabledList({
    cliValue: options.middlewares?.join(","),
    env,
    envVar: "N8N_MIDDLEWARES",
    fallback: DEFAULT_MIDDLEWARE_CHAIN,
  });
  const filtered = options.noLint ? enabled.filter((n) => n !== "lint") : enabled;
  if (filtered.length === 0) return;

  const legacyCliOpts: Record<string, unknown> = {
    ...(options.lintConfigPath ? { lintConfig: options.lintConfigPath } : {}),
    ...(options.lintDisableRules?.length ? { lintDisableRule: options.lintDisableRules } : {}),
    ...(options.middlewareCliOptions ?? {}),
  };

  let chain: PreWriteMiddleware[];
  try {
    chain = buildMiddlewares({ enabled: filtered, env, cliOpts: legacyCliOpts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  try {
    await preparePipeline(chain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    console.error("Fix the config file, or pass --no-lint to bypass the pre-write check.");
    process.exit(1);
  }

  const verdict = await runPipeline(chain, {
    workflow: options.workflow as Workflow,
    rawJSON: undefined,
    mode: "single",
  });
  await disposePipeline(chain);

  const warnings = verdict.violations.filter((v) => v.severity === "warning");
  for (const v of warnings) {
    console.error(formatViolationLine(options.source, v));
  }

  if (!verdict.block) return;

  const errors = verdict.violations.filter((v) => v.severity === "error" || !v.severity);
  // Preserve the legacy "Lint check failed …" capitalization so existing
  // log scrapers and end-to-end tests keep matching. Other middlewares use
  // a generic lowercase label.
  const mwLabel = verdict.blockedBy === "lint" ? "Lint" : (verdict.blockedBy ?? "middleware");
  console.error(
    `${mwLabel} check failed for ${options.source} (${errors.length} error${
      errors.length === 1 ? "" : "s"
    }). The workflow was NOT written upstream.`,
  );
  for (const v of errors) {
    console.error(`  ${formatViolationLine(options.source, v)}`);
  }
  if (verdict.blockedBy === "lint") {
    console.error(
      "Run `n8n-cli lint -f <file>` to iterate locally, or pass --no-lint to bypass once.",
    );
  }
  process.exit(1);
}
