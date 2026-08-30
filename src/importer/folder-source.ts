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
 * `search_workflows` tool does include `parentFolderId` per workflow.
 *
 * The tool's max `limit` is 200 and it has no cursor, so a bulk listing
 * misses older workflows on a large instance. `get_workflow_details` also
 * cannot fill those gaps: n8n refuses it unless `settings.availableInMCP` is
 * on, which most as-code workflows are not. Name-filtered `search_workflows`
 * is the fallback that still returns `parentFolderId`.
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
   * `search_workflows` is the bulk path (one listing, max 200, newest first).
   * Workflows outside that window are looked up by name — still via search,
   * because that is the MCP tool that returns `parentFolderId` for workflows
   * that are not MCP-enabled. `get_workflow_details` is a last resort and
   * only records a folder when n8n actually names one: a `null` from details
   * is indistinguishable from "not loaded", so it must not become "root".
   * Folder ID → path resolution happens through the REST folders API per
   * distinct owning project, so imported files can carry human-readable
   * `folder:` paths instead of opaque IDs.
   */
  async buildFolderInfo(workflows: Workflow[]): Promise<FolderInfo> {
    const folderByWorkflow = new Map<string, string | null>();
    const wanted = new Set(workflows.map((w) => w.id).filter((id): id is string => !!id));
    const nameById = new Map<string, string>();
    for (const w of workflows) {
      if (w.id && w.name) nameById.set(w.id, w.name);
    }

    const recordHits = (items: Array<Record<string, unknown>>): void => {
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : undefined;
        if (!id || !wanted.has(id) || folderByWorkflow.has(id)) continue;
        // n8n < 2.37.0 returns search hits without parentFolderId. Missing
        // is unknown, not root — writing null would flatten UI folders.
        if (!Object.hasOwn(item, "parentFolderId")) continue;
        folderByWorkflow.set(
          id,
          typeof item.parentFolderId === "string" ? item.parentFolderId : null,
        );
      }
    };

    // Bulk: one search over the instance. The tool takes a `limit` (max 200)
    // and no pagination cursor, so this only covers the most recently updated
    // slice. Hits for workflows we are not importing are ignored.
    const resp = await this.mcp.searchWorkflows({ limit: 200 });
    recordHits(resp.data);

    // Name-filtered search: n8n matches on name/description, still returns
    // parentFolderId, and is not gated on availableInMCP.
    for (const id of wanted) {
      if (folderByWorkflow.has(id)) continue;
      const name = nameById.get(id)?.trim();
      if (!name) continue;
      try {
        const named = await this.mcp.searchWorkflows({ limit: 200, query: name });
        recordHits(named.data);
      } catch {
        // Same degrade as details: unknown, not root.
      }
    }

    // Last resort for MCP-enabled workflows the name search still missed.
    // Only a concrete folder id is trusted — details often emits null when
    // the parentFolder relation was not loaded.
    for (const id of wanted) {
      if (folderByWorkflow.has(id)) continue;
      try {
        const details = await this.mcp.getWorkflowDetails(id);
        const parentFolderId = details.workflow?.parentFolderId;
        if (typeof parentFolderId === "string") folderByWorkflow.set(id, parentFolderId);
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
