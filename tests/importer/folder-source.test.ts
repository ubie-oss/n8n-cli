import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "../../src/api/client.ts";
import { FolderService } from "../../src/api/folder-service.ts";
import { deriveMcpEndpointUrl, McpClient } from "../../src/api/mcp-client.ts";
import type { Folder, Workflow } from "../../src/api/types.ts";
import type { WorkflowService } from "../../src/api/workflow-service.ts";
import { resolveMcpClientSettings } from "../../src/config/mcp.ts";
import { ImportExecutor } from "../../src/importer/executor.ts";
import { McpFolderSource } from "../../src/importer/folder-source.ts";
import { defaultImportOptions } from "../../src/importer/types.ts";

/**
 * import × folders: folder assignments are invisible over the REST API, so
 * the MCP folder source is the only way import can attach them. These tests
 * pin the wiring — what lands in the files, and what happens when MCP is
 * unavailable, in both strict and degrading modes.
 */

function remoteWorkflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `wf-${id}`,
    active: false,
    nodes: [],
    connections: {},
    shared: [{ role: "workflow:owner", projectId: "p1" }],
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  } as Workflow;
}

function fakeFolderService(folders: Folder[]): FolderService {
  const client = {
    get: async (p: string) =>
      p.startsWith("/projects/")
        ? JSON.stringify({ count: folders.length, data: folders })
        : JSON.stringify({}),
  } as unknown as Client;
  return new FolderService(client);
}

/** In-memory MCP tool server for the folder-reading tools. */
function fakeMcpClient(state: {
  search?: Array<Record<string, unknown>>;
  details?: Record<string, Record<string, unknown>>;
  fail?: boolean;
}): McpClient {
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    if (state.fail) return new Response("boom", { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    let result: unknown;
    if (body.method === "initialize") {
      result = { protocolVersion: "2025-06-18" };
    } else if (body.params?.name === "search_workflows") {
      result = {
        structuredContent: { data: state.search ?? [], count: (state.search ?? []).length },
      };
    } else if (body.params?.name === "get_workflow_details") {
      const wf = state.details?.[String(body.params.arguments?.workflowId ?? "")];
      result = wf
        ? { structuredContent: { workflow: wf } }
        : { isError: true, content: [{ type: "text", text: "not found" }] };
    } else {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } }),
        {
          status: 200,
        },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
  }) as typeof fetch;

  return new McpClient({ endpointUrl: "https://n8n.example.com/mcp-server/http", fetchImpl });
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-import-folders-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeExecutor(
  service: WorkflowService,
  opts?: { mcpStrict?: boolean },
): { executor: ImportExecutor; importOpts: ReturnType<typeof defaultImportOptions> } {
  const importOpts = defaultImportOptions();
  importOpts.directory = dir;
  importOpts.mcpStrict = opts?.mcpStrict ?? false;
  const executor = new ImportExecutor(service, importOpts);
  return { executor, importOpts };
}

describe("McpFolderSource.buildFolderInfo", () => {
  test("maps workflow → folder from the bulk search and resolves paths", async () => {
    const mcp = fakeMcpClient({
      search: [
        { id: "wf1", parentFolderId: "fold1" },
        { id: "wf2", parentFolderId: null },
        { id: "wf3", parentFolderId: "fold-deleted" },
      ],
    });
    const source = new McpFolderSource(
      mcp,
      fakeFolderService([
        { id: "fold1", name: "Reporting", parentFolderId: null },
        { id: "nested", name: "Daily", parentFolderId: "fold1" },
      ]),
    );

    const info = await source.buildFolderInfo([
      remoteWorkflow("wf1"),
      remoteWorkflow("wf2"),
      remoteWorkflow("wf3"),
    ]);

    expect(info.folderByWorkflow.get("wf1")).toBe("fold1");
    expect(info.folderByWorkflow.get("wf2")).toBeNull(); // root, explicitly
    expect(info.pathById.get("fold1")).toBe("Reporting");
    // A folder the API no longer lists keeps its ID as the addressable path.
    expect(info.pathById.get("fold-deleted")).toBe("fold-deleted");
  });

  test("workflows the search did not cover fall back to get_workflow_details", async () => {
    const mcp = fakeMcpClient({
      search: [{ id: "wf1", parentFolderId: "fold1" }],
      details: { wf2: { id: "wf2", parentFolderId: "fold1" } },
    });
    const source = new McpFolderSource(
      mcp,
      fakeFolderService([{ id: "fold1", name: "Reporting", parentFolderId: null }]),
    );

    const info = await source.buildFolderInfo([remoteWorkflow("wf1"), remoteWorkflow("wf2")]);

    expect(info.folderByWorkflow.get("wf1")).toBe("fold1");
    expect(info.folderByWorkflow.get("wf2")).toBe("fold1");
  });

  test("a workflow no MCP tool can resolve is simply absent from the map", async () => {
    const mcp = fakeMcpClient({ search: [] });
    const source = new McpFolderSource(mcp, fakeFolderService([]));

    const info = await source.buildFolderInfo([remoteWorkflow("wf-missing")]);
    expect(info.folderByWorkflow.has("wf-missing")).toBe(false);
  });

  test("a folder-API failure degrades to ID-addressable paths", async () => {
    const mcp = fakeMcpClient({ search: [{ id: "wf1", parentFolderId: "fold1" }] });
    const failing = new FolderService({
      get: async () => {
        throw new Error("not licensed");
      },
    } as unknown as Client);
    const source = new McpFolderSource(mcp, failing);

    const info = await source.buildFolderInfo([remoteWorkflow("wf1")]);
    expect(info.pathById.get("fold1")).toBe("fold1");
  });
});

describe("import with a folder source", () => {
  function mockWorkflowService(workflows: Workflow[]): WorkflowService {
    return {
      listWorkflows: async () => ({ data: workflows, nextCursor: null }),
      listAllWorkflows: async () => workflows,
    } as unknown as WorkflowService;
  }

  test("JSON files carry parentFolderId; the folder path rides along", async () => {
    const { executor } = makeExecutor(mockWorkflowService([remoteWorkflow("wf1")]));
    executor.setFolderSource(
      new McpFolderSource(
        fakeMcpClient({ search: [{ id: "wf1", parentFolderId: "fold1" }] }),
        fakeFolderService([{ id: "fold1", name: "Reporting", parentFolderId: null }]),
      ),
    );

    await executor.execute();

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "wf-wf1__wf1.json"), "utf-8"),
    ) as Workflow;
    expect(written.parentFolderId).toBe("fold1");
    expect(written.folder).toBe("Reporting");
  });

  test("an explicit project-root assignment is written as folder: null, not dropped", async () => {
    const { executor } = makeExecutor(mockWorkflowService([remoteWorkflow("wf2")]));
    executor.setFolderSource(
      new McpFolderSource(
        fakeMcpClient({ search: [{ id: "wf2", parentFolderId: null }] }),
        fakeFolderService([]),
      ),
    );

    await executor.execute();

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "wf-wf2__wf2.json"), "utf-8"),
    ) as Workflow;
    expect(written.parentFolderId).toBeNull();
    expect(written.folder).toBeNull();
  });

  test("YAML files carry the folder path", async () => {
    const { executor, importOpts } = makeExecutor(mockWorkflowService([remoteWorkflow("wf1")]));
    importOpts.yamlEnabled = true;
    executor.setFolderSource(
      new McpFolderSource(
        fakeMcpClient({ search: [{ id: "wf1", parentFolderId: "fold1" }] }),
        fakeFolderService([{ id: "fold1", name: "Reporting", parentFolderId: null }]),
      ),
    );

    await executor.execute();

    const text = fs.readFileSync(path.join(dir, "wf-wf1__wf1.yaml"), "utf-8");
    expect(text).toContain("folder: Reporting");
  });

  test("a workflow the source cannot resolve keeps no folder keys (unknown ≠ root)", async () => {
    const { executor } = makeExecutor(mockWorkflowService([remoteWorkflow("wf-x")]));
    executor.setFolderSource(
      new McpFolderSource(fakeMcpClient({ search: [] }), fakeFolderService([])),
    );

    await executor.execute();

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "wf-wf-x__wf-x.json"), "utf-8"),
    ) as Workflow;
    expect(written.parentFolderId).toBeUndefined();
    expect(written.folder).toBeUndefined();
  });

  test("an MCP failure degrades to a warning and imports without folder data", async () => {
    const { executor } = makeExecutor(mockWorkflowService([remoteWorkflow("wf1")]));
    executor.setFolderSource(
      new McpFolderSource(fakeMcpClient({ fail: true }), fakeFolderService([])),
    );

    await executor.execute();

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "wf-wf1__wf1.json"), "utf-8"),
    ) as Workflow;
    expect(written.parentFolderId).toBeUndefined();
  });

  test("mcpStrict turns an MCP failure into an import error", async () => {
    const { executor } = makeExecutor(mockWorkflowService([remoteWorkflow("wf1")]), {
      mcpStrict: true,
    });
    executor.setFolderSource(
      new McpFolderSource(fakeMcpClient({ fail: true }), fakeFolderService([])),
    );

    expect(executor.execute()).rejects.toThrow(/MCP/);
  });
});

describe("import without a folder source", () => {
  test("behaves exactly as before — no folder keys are invented", async () => {
    const importOpts = defaultImportOptions();
    importOpts.directory = dir;
    const executor = new ImportExecutor(
      {
        listWorkflows: async () => ({ data: [remoteWorkflow("wf1")], nextCursor: null }),
      } as unknown as WorkflowService,
      importOpts,
    );
    await executor.execute();
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "wf-wf1__wf1.json"), "utf-8"),
    ) as Workflow;
    expect(written.parentFolderId).toBeUndefined();
    expect(written.folder).toBeUndefined();
  });
});

describe("resolveMcpClientSettings", () => {
  const base = { env: {} as NodeJS.ProcessEnv };

  test("off by default", () => {
    expect(resolveMcpClientSettings(base)).toMatchObject({ enabled: false, mode: "off" });
  });

  test("a token implies enabled in direct mode (flag, env, or rc)", () => {
    expect(resolveMcpClientSettings({ ...base, flagToken: "t" })).toMatchObject({
      enabled: true,
      mode: "direct",
      token: "t",
    });
    expect(resolveMcpClientSettings({ env: { N8N_MCP_TOKEN: "e" } })).toMatchObject({
      enabled: true,
      mode: "direct",
      token: "e",
    });
    expect(resolveMcpClientSettings({ rc: { token: "r" } })).toMatchObject({
      enabled: true,
      mode: "direct",
      token: "r",
    });
  });

  test("no token + explicit opt-in resolves to proxy mode (the proxy injects)", () => {
    const viaFlag = resolveMcpClientSettings({ ...base, flagEnabled: true });
    expect(viaFlag.enabled).toBe(true);
    expect(viaFlag.mode).toBe("proxy");
    expect(viaFlag.token).toBeUndefined();
    expect(resolveMcpClientSettings({ env: { N8N_MCP: "1" } })).toMatchObject({
      enabled: true,
      mode: "proxy",
    });
    expect(resolveMcpClientSettings({ rc: { mode: "proxy" } })).toMatchObject({
      enabled: true,
      mode: "proxy",
    });
  });

  test("flags win over env wins over rc", () => {
    expect(
      resolveMcpClientSettings({
        flagToken: "flag",
        env: { N8N_MCP_TOKEN: "env" },
        rc: { token: "rc" },
      }).token,
    ).toBe("flag");
    expect(
      resolveMcpClientSettings({
        env: { N8N_MCP_TOKEN: "env" },
        rc: { token: "rc" },
      }).token,
    ).toBe("env");
  });

  test("strict comes from the flag or the rc", () => {
    expect(resolveMcpClientSettings({ ...base, flagStrict: true }).strict).toBe(true);
    expect(resolveMcpClientSettings({ rc: { strict: true } }).strict).toBe(true);
    expect(resolveMcpClientSettings(base).strict).toBe(false);
  });

  test("deriveMcpEndpointUrl matches the Client's /api/v1 normalisation", () => {
    expect(deriveMcpEndpointUrl("https://x.example.com")).toContain("/mcp-server/http");
  });
});
