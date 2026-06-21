import type { Client } from "./client.ts";
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
  async createWorkflow(input: WorkflowInput): Promise<Workflow> {
    const data = await this.client.post("/workflows", input);
    return JSON.parse(data) as Workflow;
  }

  /** UpdateWorkflow updates an existing workflow */
  async updateWorkflow(id: string, input: WorkflowInput): Promise<Workflow> {
    const path = `/workflows/${encodeURIComponent(id)}`;
    const data = await this.client.put(path, input);
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
   * GetWorkflowCurrentProjectID returns the current project ID of a workflow.
   * Returns empty string if the workflow has no shared project info.
   */
  getWorkflowCurrentProjectID(workflow: Workflow | null): string {
    if (!workflow?.shared?.length) {
      return "";
    }

    // Find the owner project
    const owner = workflow.shared.find((s) => s.role === "workflow:owner");
    if (owner) {
      return owner.projectId;
    }

    // Fallback to first project if no owner found
    return workflow.shared[0]?.projectId ?? "";
  }
}
