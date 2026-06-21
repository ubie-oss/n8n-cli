import type { Workflow } from "../api/types.ts";
import type { WorkflowService } from "../api/workflow-service.ts";
import type { DuplicateWarning } from "./types.ts";

/** DuplicateChecker checks for potential duplicate workflows on the remote server. */
export class DuplicateChecker {
  private remoteWorkflows = new Map<string, Workflow[]>();
  private loaded = false;

  constructor(private readonly workflowService: WorkflowService) {}

  /**
   * Fetches all remote workflows and indexes them by name.
   *
   * Capped at 50 pages (5000 workflows at the default limit) so a misbehaving
   * upstream can't keep the apply step paginating forever. Real n8n
   * deployments well above this size should pass `--allow-duplicates`.
   */
  async loadRemoteWorkflows(): Promise<void> {
    if (this.loaded) return;

    this.remoteWorkflows = new Map();
    const workflows = await this.workflowService.listAllWorkflows({
      limit: 100,
      maxPages: 50,
    });

    for (const workflow of workflows) {
      if (workflow.name) {
        const existing = this.remoteWorkflows.get(workflow.name) ?? [];
        existing.push(workflow);
        this.remoteWorkflows.set(workflow.name, existing);
      }
    }

    this.loaded = true;
  }

  /**
   * FindDuplicatesByName checks if a workflow with the given name already exists remotely.
   * Only reports duplicates for workflows that don't have an ID (new workflows).
   */
  findDuplicatesByName(localPath: string, localName: string): DuplicateWarning[] {
    const warnings: DuplicateWarning[] = [];
    const remotes = this.remoteWorkflows.get(localName);
    if (!remotes || remotes.length === 0) return warnings;

    for (const remote of remotes) {
      warnings.push({
        localPath,
        localName,
        remoteID: remote.id ?? "",
        remoteName: remote.name,
        remoteActive: remote.active,
      });
    }

    return warnings;
  }
}
