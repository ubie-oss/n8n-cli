import type { Workflow } from "@/api/types.ts";

/**
 * Returns the project that owns a workflow, mirroring n8n's `shared` payload.
 *
 * Prefers the entry whose role is `workflow:owner`; otherwise falls back to the
 * first shared project. An empty string means the workflow carries no project
 * context the proxy can enforce against.
 */
export function workflowProjectId(workflow: Workflow | null | undefined): string {
  if (!workflow?.shared?.length) return "";
  const owner = workflow.shared.find((s) => s.role === "workflow:owner");
  if (owner) return owner.projectId;
  return workflow.shared[0]?.projectId ?? "";
}
