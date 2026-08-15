import { workflowProjectId } from "@/common/project-id.ts";
import type {
  MiddlewareVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";
import { ProjectRoleChecker, type ProjectRoleCheckerDeps } from "./checker.ts";
import type { ProjectRoleOptions } from "./types.ts";

export class ProjectRoleMiddleware implements ServerMiddleware {
  readonly name = "project-role";
  readonly readsWorkflowBody = false;
  readonly checker: ProjectRoleChecker;

  constructor(
    private readonly options: ProjectRoleOptions,
    deps: ProjectRoleCheckerDeps,
  ) {
    this.checker = new ProjectRoleChecker(options, deps);
  }

  async evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> {
    if (this.options.enforce === "off") return pass();
    if (ctx.mode !== "proxy") return pass();
    if (!this.checker.shouldApplyToAction(ctx.action)) return pass();

    const level = this.checker.actionAccessLevel(ctx.action);
    if (!level) return pass();

    const email = this.checker.resolveEmail(ctx);
    if (!email) {
      return this.dispatchDenial(
        "project-role-missing-identity",
        "Actor identity could not be resolved (header/env not present or claim missing)",
      );
    }

    let projectId = this.checker.resolveProjectId(ctx);
    if (!projectId && ctx.workflowId && ctx.fetchStoredWorkflow) {
      try {
        const stored = await ctx.fetchStoredWorkflow(ctx.workflowId);
        projectId = workflowProjectId(stored);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (this.options.onError === "allow") {
          return warn(`Stored workflow lookup failed (fail-open): ${message}`);
        }
        return this.dispatchDenial("project-role-stored-lookup-error", message);
      }
    }

    const verdict = await this.checker.check({ email, projectId, level });
    if (verdict.allowed) {
      if (verdict.reason && verdict.rule.endsWith("-warning")) {
        return warn(verdict.reason);
      }
      return pass();
    }
    return this.dispatchDenial(verdict.rule, verdict.reason ?? "Project role check failed");
  }

  private dispatchDenial(rule: string, message: string): MiddlewareVerdict {
    const violations = [{ rule, severity: "error" as const, message }];
    if (this.options.enforce === "warn") {
      return {
        block: false,
        violations: violations.map((v) => ({ ...v, severity: "warning" as const })),
      };
    }
    return {
      block: true,
      violations,
      denial: {
        status: 403,
        error: "workflow_project_role_denied",
        message,
      },
    };
  }
}

function pass(): MiddlewareVerdict {
  return { block: false, violations: [] };
}

function warn(message: string): MiddlewareVerdict {
  return {
    block: false,
    violations: [{ rule: "project-role-warning", severity: "warning", message }],
  };
}

export function extractProjectRoleChecker(
  middlewares: ServerMiddleware[],
): ProjectRoleChecker | null {
  for (const mw of middlewares) {
    if (mw.name === "project-role" && mw instanceof ProjectRoleMiddleware) {
      return mw.checker;
    }
  }
  return null;
}
