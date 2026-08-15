import { workflowProjectId } from "@/common/project.ts";
import { hasErrorViolations, lintWorkflow } from "@/lint/engine.ts";
import type { Violation } from "@/lint/rules/violation.ts";
import {
  prepareWriteLintContext,
  rulesForProject,
  type WriteLintContext,
} from "@/lint/write-check.ts";
import type {
  MiddlewareVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";

/**
 * Enforcement level for the lint middleware.
 *   - off:   skip linting entirely.
 *   - warn:  always pass, but surface violations for the caller to log.
 *   - error: block when any error-level violation is found.
 *
 * Same three-state semantics as the legacy proxy enforcer; preserved here
 * so behavior is bit-for-bit unchanged when only the lint middleware is
 * enabled.
 */
export type LintEnforce = "off" | "warn" | "error";

export interface LintMiddlewareOptions {
  enforce: LintEnforce;
  configPath?: string;
  disableRules?: string[];
  /**
   * Directory used as the discovery anchor for `.n8nlintrc.json`. apply
   * passes its `--dir` here so an in-tree config gets picked up regardless
   * of where the CLI was invoked from.
   */
  startDir?: string;
}

/**
 * The lint middleware reuses the existing engine and write-check helpers;
 * it adds nothing on top except wiring them into the ServerMiddleware
 * contract. The historical 422 response shape (`workflow_lint_failed`) is
 * preserved through the `denial` hint so proxy clients see no change.
 */
export class LintMiddleware implements ServerMiddleware {
  readonly name = "lint";
  readonly readsWorkflowBody = true;
  private ctx?: WriteLintContext;

  constructor(private readonly options: LintMiddlewareOptions) {}

  prepare(): void {
    if (this.options.enforce === "off") return;
    // Failures here surface to callers as LintConfigLoadError; they already
    // know how to translate that into a friendly message + bypass hint.
    this.ctx = prepareWriteLintContext(
      this.options.configPath,
      this.options.disableRules,
      this.options.startDir,
    );
  }

  async evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> {
    if (this.options.enforce === "off") {
      return { block: false, violations: [] };
    }
    if (!this.ctx) {
      // prepare() was not called — fall back to lazy init so direct unit
      // tests work without the pipeline harness.
      this.prepare();
    }

    const rawJSON = ctx.rawJSON ?? (ctx.workflow ? JSON.stringify(ctx.workflow) : "");
    const projectId = await this.resolveProjectId(ctx);
    let violations: Violation[];
    try {
      violations = lintWorkflow(
        ctx.workflow,
        rawJSON,
        rulesForProject(this.ctx!, projectId),
        this.ctx!.config,
      );
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

    if (this.options.enforce === "warn") {
      return { block: false, violations };
    }
    if (!hasErrorViolations(violations)) {
      return { block: false, violations };
    }

    const errorCount = violations.filter((v) => v.severity === "error" || !v.severity).length;
    return {
      block: true,
      violations,
      denial: {
        status: 422,
        error: "workflow_lint_failed",
        message: `Workflow violates ${errorCount} linter rule${
          errorCount === 1 ? "" : "s"
        } and was not forwarded to n8n`,
      },
    };
  }

  private async resolveProjectId(ctx: ServerMiddlewareContext): Promise<string | undefined> {
    if (ctx.projectId) return ctx.projectId;

    // API responses and exported local definitions may already carry their
    // ownership. In proxy mode an update body is caller-controlled and omits
    // `shared`, so use the stored workflow instead.
    if (ctx.mode !== "proxy") return workflowProjectId(ctx.workflow);
    if (!ctx.workflowId || !ctx.fetchStoredWorkflow) return undefined;
    if (!this.ctx?.config?.projectRulesConfig.size) return undefined;

    return workflowProjectId(await ctx.fetchStoredWorkflow(ctx.workflowId));
  }
}

export type { LintConfigLoadError } from "@/lint/write-check.ts";
