import { workflowProjectId } from "@/common/project-id.ts";
import type { Client } from "./client.ts";
import { BASE_UPDATED_AT_HEADER, PROJECT_ID_HEADER } from "./headers.ts";
import type { ListWorkflowsResponse, TransferInput, Workflow, WorkflowInput } from "./types.ts";

/** ListOptions represents options for listing workflows */
export interface ListOptions {
  active?: boolean;
  tags?: string[];
  limit?: number;
  cursor?: string;
  /**
   * Maximum number of pages to fetch in listAllWorkflows. Defaults to
   * unlimited; pass a value to cap the walk on huge instances so a runaway
   * paginator can't pin the process. Ignored by listWorkflows.
   */
  maxPages?: number;
}

/** WorkflowService handles workflow API operations */
export class WorkflowService {
  constructor(private readonly client: Client) {}

  /** ListWorkflows lists all workflows with optional filters */
  async listWorkflows(opts?: ListOptions): Promise<ListWorkflowsResponse> {
    const params = new URLSearchParams();

    if (opts) {
      if (opts.active !== undefined) {
        params.set("active", String(opts.active));
      }
      if (opts.tags) {
        for (const tag of opts.tags) {
          params.append("tags", tag);
        }
      }
      if (opts.limit && opts.limit > 0) {
        params.set("limit", String(opts.limit));
      }
      if (opts.cursor) {
        params.set("cursor", opts.cursor);
      }
    }

    const query = params.toString();
    const path = query ? `/workflows?${query}` : "/workflows";

    const data = await this.client.get(path);
    return JSON.parse(data) as ListWorkflowsResponse;
  }

  /** ListAllWorkflows lists all workflows with automatic pagination */
  async listAllWorkflows(opts?: ListOptions): Promise<Workflow[]> {
    const allWorkflows: Workflow[] = [];
    const paginationOpts: ListOptions = { ...opts };
    if (!paginationOpts.limit) {
      paginationOpts.limit = 100;
    }
    const maxPages = paginationOpts.maxPages ?? Number.POSITIVE_INFINITY;

    let page = 0;
    for (;;) {
      const resp = await this.listWorkflows(paginationOpts);
      allWorkflows.push(...resp.data);
      page++;

      if (!resp.nextCursor) {
        break;
      }
      if (page >= maxPages) {
        break;
      }
      paginationOpts.cursor = resp.nextCursor;
    }

    return allWorkflows;
  }

  /** GetWorkflow gets a workflow by ID */
  async getWorkflow(id: string): Promise<Workflow> {
    const path = `/workflows/${encodeURIComponent(id)}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as Workflow;
  }

  /** CreateWorkflow creates a new workflow */
  async createWorkflow(input: WorkflowInput, projectId?: string): Promise<Workflow> {
    const headers = projectId ? { [PROJECT_ID_HEADER]: projectId } : undefined;
    const data = await this.client.post("/workflows", input, headers);
    return JSON.parse(data) as Workflow;
  }

  /**
   * UpdateWorkflow updates an existing workflow.
   *
   * `baseUpdatedAt` is the upstream timestamp the caller's definition was
   * written from. It is advisory: n8n itself ignores it, but a `proxy` running
   * the stale-write guard uses it to reject a write whose base is no longer
   * the stored state. Omit it when the caller has no basis to claim one —
   * sending a wrong value is worse than sending none.
   */
  async updateWorkflow(
    id: string,
    input: WorkflowInput,
    baseUpdatedAt?: string,
  ): Promise<Workflow> {
    const path = `/workflows/${encodeURIComponent(id)}`;
    const headers = baseUpdatedAt ? { [BASE_UPDATED_AT_HEADER]: baseUpdatedAt } : undefined;
    const data = await this.client.put(path, input, headers);
    return JSON.parse(data) as Workflow;
  }

  /** DeleteWorkflow deletes a workflow */
  async deleteWorkflow(id: string): Promise<void> {
    const path = `/workflows/${encodeURIComponent(id)}`;
    await this.client.delete(path);
  }

  /** ActivateWorkflow activates a workflow */
  async activateWorkflow(id: string): Promise<Workflow> {
    const path = `/workflows/${encodeURIComponent(id)}/activate`;
    const data = await this.client.post(path);
    return JSON.parse(data) as Workflow;
  }

  /** DeactivateWorkflow deactivates a workflow */
  async deactivateWorkflow(id: string): Promise<Workflow> {
    const path = `/workflows/${encodeURIComponent(id)}/deactivate`;
    const data = await this.client.post(path);
    return JSON.parse(data) as Workflow;
  }

  /** TransferWorkflow transfers a workflow to a different project */
  async transferWorkflow(id: string, destinationProjectId: string): Promise<void> {
    const path = `/workflows/${encodeURIComponent(id)}/transfer`;
    const input: TransferInput = { destinationProjectId };
    await this.client.put(path, input);
  }

  /**
   * MoveWorkflowToFolder moves a workflow into a folder (or to the project
   * root with `null`) via the workflow PATCH endpoint's `parentFolderId`.
   *
   * This is the only way to observe or change a workflow's folder through the
   * REST API besides create-time assignment: the field is `writeOnly`, so the
   * move is fire-and-confirm-by-status — the response cannot echo the new
   * folder back.
   */
  async moveWorkflowToFolder(id: string, parentFolderId: string | null): Promise<Workflow> {
    const path = `/workflows/${encodeURIComponent(id)}`;
    const data = await this.client.patch(path, { parentFolderId });
    return JSON.parse(data) as Workflow;
  }

  /**
   * GetWorkflowCurrentProjectID returns the current project ID of a workflow.
   * Returns empty string if the workflow has no shared project info.
   */
  getWorkflowCurrentProjectID(workflow: Workflow | null): string {
    return workflowProjectId(workflow);
  }
}
