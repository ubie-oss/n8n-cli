import { workflowProjectId } from "@/common/project-id.ts";
import { resolveIdentity } from "@/middleware/identity.ts";
import type { ServerMiddlewareContext } from "@/middleware/types.ts";
import { N8nProjectApi, type N8nProjectApiDeps } from "./n8n-api.ts";
import { type AccessLevel, isInstanceWideAdmin, projectRoleSatisfies } from "./roles.ts";
import type { ProjectRoleOptions } from "./types.ts";

export interface ProjectRoleCheckInput {
  email: string;
  projectId: string;
  level: AccessLevel;
}

export interface ProjectRoleCheckResult {
  allowed: boolean;
  reason?: string;
  rule: string;
}

export interface ProjectRoleCheckerDeps extends N8nProjectApiDeps {}

/**
 * Shared decision engine for REST writes, REST reads, and MCP tool calls.
 */
export class ProjectRoleChecker {
  readonly api: N8nProjectApi;

  constructor(
    private readonly options: ProjectRoleOptions,
    deps: ProjectRoleCheckerDeps,
  ) {
    this.api = new N8nProjectApi(deps, options.membersCacheTtlMs, options.instanceRoleCacheTtlMs);
  }

  resolveEmail(ctx: ServerMiddlewareContext): string | undefined {
    if (ctx.identity?.trim()) return ctx.identity.trim();
    if (ctx.auth?.effective?.email?.trim()) return ctx.auth.effective.email.trim();
    return resolveIdentity(this.options.identity, {
      request: ctx.request,
      env: process.env,
    })?.trim();
  }

  resolveProjectId(ctx: ServerMiddlewareContext): string {
    return workflowProjectId(ctx.workflow);
  }

  async check(input: ProjectRoleCheckInput): Promise<ProjectRoleCheckResult> {
    const { email, projectId, level } = input;
    if (!projectId) {
      if (this.options.onMissingProject === "allow") {
        return { allowed: true, rule: "project-role-missing-project-allowed" };
      }
      return {
        allowed: false,
        rule: "project-role-missing-project",
        reason:
          "The target workflow does not declare a project, so this proxy cannot verify n8n project membership.",
      };
    }

    try {
      const instanceRole = await this.api.instanceRoleForEmail(email);
      if (isInstanceWideAdmin(instanceRole)) {
        return { allowed: true, rule: "project-role-instance-admin" };
      }

      const projectRole = await this.api.projectRoleForEmail(projectId, email);
      if (projectRoleSatisfies(projectRole, level)) {
        return { allowed: true, rule: "project-role-allowed" };
      }

      const needed = level === "write" ? "project:editor or higher" : "project:viewer or higher";
      const have = projectRole ?? "no project membership";
      return {
        allowed: false,
        rule: "project-role-denied",
        reason: `Identity "${email}" has ${have} in project ${projectId}, but ${needed} is required.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.options.onError === "allow") {
        return {
          allowed: true,
          rule: "project-role-lookup-warning",
          reason: `Membership lookup failed (fail-open): ${message}`,
        };
      }
      return {
        allowed: false,
        rule: "project-role-lookup-error",
        reason: `Membership lookup failed: ${message}`,
      };
    }
  }

  actionAccessLevel(action: string | undefined): AccessLevel | undefined {
    if (!action) return undefined;
    if (action === "read") return "read";
    if (
      action === "create" ||
      action === "update" ||
      action === "delete" ||
      action === "activate"
    ) {
      return "write";
    }
    if (action === "tags") return "write";
    return undefined;
  }

  shouldApplyToAction(action: string | undefined): boolean {
    const scoped = this.options.actions;
    if (scoped.length === 0) return true;
    return !!action && scoped.includes(action);
  }
}
