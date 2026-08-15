import type { Workflow } from "@/api/types.ts";

/** Returns the owning n8n project ID carried by a workflow API response. */
export function workflowProjectId(workflow: Workflow | null | undefined): string | undefined {
  if (!workflow?.shared?.length) return undefined;
  return (
    workflow.shared.find((share) => share.role === "workflow:owner")?.projectId ??
    workflow.shared[0]?.projectId
  );
}
