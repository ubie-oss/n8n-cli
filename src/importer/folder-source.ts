import type { FolderService } from "@/api/folder-service.ts";
import { buildFolderIndex } from "@/api/folder-service.ts";
import type { McpClient } from "@/api/mcp-client.ts";
import type { Workflow } from "@/api/types.ts";
import { workflowProjectId } from "@/common/project-id.ts";

/**
 * Folder information for an import run, sourced from n8n's instance-level MCP
 * server.
 *
 * The public REST API never returns which folder a workflow sits in
 * (`parentFolderId` is `writeOnly` in n8n's schema), so `import` can only
 * attach folder assignments when an MCP connection is available: the MCP
 * `search_workflows` tool does include `parentFolderId` per workflow, and
 * `get_workflow_details` fills gaps for workflows the search does not cover.
 */
export interface FolderInfo {
  /**
   * workflow ID → parent folder ID (null = project root). Only workflows the
   * MCP server could resolve appear here.
   */
  folderByWorkflow: Map<string, string | null>;
  /** folder ID → `/`-separated path from its project root. */
  pathById: Map<string, string>;
}

export class McpFolderSource {
  constructor(
    private readonly mcp: McpClient,
    private readonly folderService: FolderService,
  ) {}

  /**
   * Builds the folder info for the given remote workflows.
   *
   * `search_workflows` is the bulk path (one paginated walk for the whole
   * instance); `get_workflow_details` is the per-workflow fallback for
   * workflows the search did not cover. Folder ID → path resolution happens
   * through the REST folders API per distinct owning project, so imported
   * files can carry human-readable `folder:` paths instead of opaque IDs.
   */
  async buildFolderInfo(workflows: Workflow[]): Promise<FolderInfo> {
    const folderByWorkflow = new Map<string, string | null>();
    const wanted = new Set(workflows.map((w) => w.id).filter((id): id is string => !!id));

    // Bulk: one search over the instance. The tool takes a `limit` (max 200)
    // but no pagination cursor, so beyond 200 workflows the per-workflow
    // fallback below fills the gaps.
    const resp = await this.mcp.searchWorkflows({ limit: 200 });
    for (const item of resp.data) {
      const id = typeof item.id === "string" ? item.id : undefined;
      if (!id) continue;
      folderByWorkflow.set(
        id,
        typeof item.parentFolderId === "string" ? item.parentFolderId : null,
      );
    }

    // Fallback: ask for details on workflows the search did not cover.
    for (const id of wanted) {
      if (folderByWorkflow.has(id)) continue;
      try {
        const details = await this.mcp.getWorkflowDetails(id);
        const workflow = details.workflow;
        const parentFolderId = workflow?.parentFolderId;
        folderByWorkflow.set(id, typeof parentFolderId === "string" ? parentFolderId : null);
      } catch {
        // Leave unresolvable workflows out of the map — the writer treats an
        // absent entry as "folder unknown", not as "project root".
      }
    }

    // Folder ID → path, via the REST folders API per distinct project.
    const pathById = new Map<string, string>();
    const folderIds = new Set<string>();
    for (const parent of folderByWorkflow.values()) {
      if (parent) folderIds.add(parent);
    }
    if (folderIds.size > 0) {
      const projects = new Set<string>();
      for (const workflow of workflows) {
        const projectId = workflowProjectId(workflow);
        if (projectId) projects.add(projectId);
      }
      for (const projectId of projects) {
        try {
          const folders = await this.folderService.listAllFolders(projectId);
          const { pathById: paths } = buildFolderIndex(folders);
          for (const [id, p] of paths) pathById.set(id, p);
        } catch {
          // Folder listing may be unlicensed even when MCP works; paths fall
          // back to raw IDs in that case.
        }
      }
      // Any folder ID the listings did not cover stays addressable by its ID
      // rather than dropping the assignment.
      for (const id of folderIds) {
        if (!pathById.has(id)) pathById.set(id, id);
      }
    }

    return { folderByWorkflow, pathById };
  }
}
