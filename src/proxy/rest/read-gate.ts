import type { Workflow } from "@/api/types.ts";
import { workflowProjectId } from "@/common/project-id.ts";
import type { ProjectRoleChecker } from "@/middleware/builtin/project-role/checker.ts";
import type { PipelineVerdict } from "@/middleware/types.ts";

export interface ReadGateDeps {
  checker: ProjectRoleChecker;
  fetchStoredWorkflow: (id: string, apiKey: string | null) => Promise<Workflow | null>;
}

/**
 * Runs the project-role checker for a GET /api/v1/workflows/:id request.
 * Returns a pipeline-shaped denial when the caller lacks viewer access.
 */
export async function evaluateWorkflowReadGate(
  req: Request,
  workflowId: string,
  deps: ReadGateDeps,
): Promise<PipelineVerdict | null> {
  const checker = deps.checker;
  if (!checker.shouldApplyToAction("read")) return null;

  const ctx = {
    workflow: null,
    request: req,
    mode: "proxy" as const,
    action: "read",
    workflowId,
    fetchStoredWorkflow: (id: string) =>
      deps.fetchStoredWorkflow(id, req.headers.get("x-n8n-api-key")),
  };

  const email = checker.resolveEmail(ctx);
  if (!email) {
    return denial("project-role-missing-identity", "Actor identity could not be resolved");
  }

  let stored: Workflow | null;
  try {
    stored = await deps.fetchStoredWorkflow(workflowId, req.headers.get("x-n8n-api-key"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return denial("project-role-stored-lookup-error", message);
  }

  const projectId = workflowProjectId(stored);
  const verdict = await checker.check({ email, projectId, level: "read" });
  if (verdict.allowed) return null;
  return denial(verdict.rule, verdict.reason ?? "Project role check failed");
}

function denial(rule: string, message: string): PipelineVerdict {
  return {
    block: true,
    blockedBy: "project-role",
    violations: [{ rule, severity: "error", message }],
    denial: {
      status: 403,
      error: "workflow_project_role_denied",
      message,
    },
  };
}
