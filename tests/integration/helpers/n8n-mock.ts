import type { Folder, Workflow } from "@/api/types.ts";

export interface CapturedRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

export interface N8nMock {
  port: number;
  captured: CapturedRequest[];
  workflows: Map<string, Workflow>;
  /** Requests that would mutate upstream state (not the proxy's own GETs). */
  writes: () => CapturedRequest[];
  get: (id: string) => Workflow | undefined;
  stop: () => Promise<void>;
}

export interface N8nMockOptions {
  workflows?: Workflow[];
  /** When set, any other `X-N8N-API-KEY` is answered with 401. */
  requiredApiKey?: string;
  /**
   * Caps each `GET /workflows` page. The CLI paginates with `limit` + `cursor`;
   * leaving this unset returns the full list in one response.
   */
  listPageSize?: number;
  /**
   * Folder store keyed by project ID, served from
   * `GET /api/v1/projects/:projectId/folders`.
   */
  folders?: Record<string, Folder[]>;
  /**
   * MCP access token for the `/mcp-server/http` endpoint. When set, requests
   * without exactly this Bearer token are answered with 401 — the seam that
   * proves a proxy-injected token (or a CLI-held one) actually arrived.
   */
  mcpToken?: string;
  /**
   * workflow ID → parent folder ID (null = project root) reported by the
   * mock's MCP server. Folder assignments are write-only over REST, so the
   * MCP surface is the only way to read them back — exactly as on a real n8n.
   */
  mcpFolderAssignments?: Record<string, string | null>;
  /**
   * Escape hatch for error-injection tests. Return a Response to short-circuit
   * the mock, or null to fall through to the in-memory store.
   */
  hook?: (req: Request, url: URL) => Response | null | Promise<Response | null>;
}

/**
 * In-memory stand-in for n8n's public REST API, covering the endpoints the
 * CLI actually calls through the proxy (list/get/create/update/delete,
 * activate, tags).
 */
export function startN8nMock(opts: N8nMockOptions = {}): N8nMock {
  const workflows = new Map<string, Workflow>();
  const captured: CapturedRequest[] = [];
  let seq = 0;

  for (const wf of opts.workflows ?? []) {
    const id = wf.id ?? `seed-${++seq}`;
    workflows.set(id, clone({ ...wf, id, ...timestamps(wf) }));
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        headers,
        body,
      });

      if (opts.hook) {
        const hijack = await opts.hook(req, url);
        if (hijack) return hijack;
      }

      if (opts.requiredApiKey) {
        const key = req.headers.get("x-n8n-api-key");
        if (key !== opts.requiredApiKey) {
          return json({ message: "Unauthorized" }, 401);
        }
      }

      return route(req.method, url, body);
    },
  });

  function route(method: string, url: URL, raw: string): Response {
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/v1/tags") {
      if (method === "GET") return json({ data: [], nextCursor: null });
      if (method === "POST") {
        const input = parseBody(raw);
        return json({ id: `tag-${++seq}`, name: String(input.name ?? "tag") });
      }
    }

    // Folder routes (enterprise feature on a real n8n).
    const folderRoute = path.match(/^\/api\/v1\/projects\/([^/]+)\/folders(?:\/([^/]+))?$/);
    if (folderRoute) {
      const projectId = decodeURIComponent(folderRoute[1]!);
      const folderId = folderRoute[2] ? decodeURIComponent(folderRoute[2]) : undefined;
      const store = opts.folders?.[projectId] ?? [];
      if (method === "GET" && !folderId) {
        return json({ count: store.length, data: store.map(clone) });
      }
      if (method === "GET" && folderId) {
        const folder = store.find((f) => f.id === folderId);
        return folder ? json(clone(folder)) : json({ message: "Resource not found" }, 404);
      }
      if (method === "POST" && !folderId) {
        const input = parseBody(raw);
        const folder: Folder = {
          id: `folder-${++seq}`,
          name: String(input.name ?? "folder"),
          parentFolderId: typeof input.parentFolderId === "string" ? input.parentFolderId : null,
          projectId,
        };
        opts.folders ??= {};
        opts.folders[projectId] = [...(opts.folders[projectId] ?? []), folder];
        return json(clone(folder), 201);
      }
    }

    // Instance-level MCP server (Streamable HTTP JSON-RPC).
    if (path === "/mcp-server/http") {
      if (method !== "POST") return json({ message: "Method not allowed" }, 405);
      return mcpEndpoint(raw);
    }

    if (path === "/api/v1/workflows") {
      if (method === "GET") return listWorkflows(url);
      if (method === "POST") return createWorkflow(raw);
    }

    const wfMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)(?:\/(activate|deactivate|tags))?$/);
    if (wfMatch) {
      const id = decodeURIComponent(wfMatch[1]!);
      const sub = wfMatch[2];
      if (!sub) {
        if (method === "GET") return getWorkflow(id);
        if (method === "PUT") return updateWorkflow(id, raw);
        if (method === "PATCH") return patchWorkflow(id, raw);
        if (method === "DELETE") return deleteWorkflow(id);
      }
      if (sub === "activate" && method === "POST") return setActive(id, true);
      if (sub === "deactivate" && method === "POST") return setActive(id, false);
      if (sub === "tags" && method === "PUT") return getWorkflow(id);
    }

    return json({ message: "Not found" }, 404);
  }

  function mcpEndpoint(raw: string): Response {
    if (opts.mcpToken) {
      const auth = captured[captured.length - 1]?.headers["authorization"];
      if (auth !== `Bearer ${opts.mcpToken}`) {
        return json({ message: "Unauthorized" }, 401);
      }
    }
    const message = parseBody(raw) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    // JSON-RPC notifications carry no id and get no response body.
    if (typeof message.method === "string" && message.method.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }
    if (message.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "n8n-mock", version: "1.0.0" },
        },
      });
    }
    if (message.method === "tools/call") {
      const params = message.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === "search_workflows") {
        const data = [...workflows.values()].map((w) => ({
          id: w.id,
          name: w.name,
          active: w.active,
          parentFolderId: opts.mcpFolderAssignments?.[w.id ?? ""] ?? null,
          availableInMCP: false,
          tags: [],
        }));
        return json({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [], structuredContent: { data, count: data.length } },
        });
      }
      if (name === "get_workflow_details") {
        const wf = workflows.get(String(args.workflowId ?? ""));
        if (!wf) {
          return json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "workflow not found" },
          });
        }
        return json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [],
            structuredContent: {
              workflow: {
                id: wf.id,
                name: wf.name,
                active: wf.active,
                parentFolderId: opts.mcpFolderAssignments?.[wf.id ?? ""] ?? null,
              },
            },
          },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      });
    }
    return json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32601, message: "unknown method" },
    });
  }

  /**
   * n8n's PATCH /workflows/:id partial update — the endpoint that carries
   * `parentFolderId` (write-only: stored but never echoed back on GET).
   */
  function patchWorkflow(id: string, raw: string): Response {
    const existing = workflows.get(id);
    if (!existing) return json({ message: "Resource not found" }, 404);
    const input = parseBody(raw);
    if (!("parentFolderId" in input)) {
      return json({ message: "Unsupported patch" }, 400);
    }
    const value = input.parentFolderId;
    (existing as Workflow & { parentFolderId?: string | null }).parentFolderId =
      typeof value === "string" ? value : null;
    return json(clone(existing));
  }

  function listWorkflows(url: URL): Response {
    let items = [...workflows.values()];
    const active = url.searchParams.get("active");
    if (active === "true") items = items.filter((w) => w.active);
    if (active === "false") items = items.filter((w) => !w.active);

    const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const pageSize =
      opts.listPageSize ?? (Number.isFinite(requested) && requested > 0 ? requested : items.length);
    const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10) || 0;
    const page = items.slice(cursor, cursor + pageSize);
    const next = cursor + pageSize;
    return json({
      data: page.map((w) => clone(stripWriteOnly(w))),
      nextCursor: next < items.length ? String(next) : null,
    });
  }

  function getWorkflow(id: string): Response {
    const wf = workflows.get(id);
    if (!wf) return json({ message: "Resource not found" }, 404);
    return json(stripWriteOnly(clone(wf)));
  }

  /**
   * `parentFolderId` is write-only in n8n's schema — stored upstream but
   * never included in a GET response. The mock honours that contract.
   */
  function stripWriteOnly(wf: Workflow): Workflow {
    const { parentFolderId: _dropped, ...rest } = wf as Workflow & {
      parentFolderId?: string | null;
    };
    return rest as Workflow;
  }

  function createWorkflow(raw: string): Response {
    const input = parseBody(raw);
    const id = `mock-${++seq}`;
    const now = nowIso();
    const stored: Workflow = {
      name: String(input.name ?? "untitled"),
      active: false,
      nodes: Array.isArray(input.nodes) ? (input.nodes as Workflow["nodes"]) : [],
      connections:
        input.connections && typeof input.connections === "object"
          ? (input.connections as Workflow["connections"])
          : {},
      id,
      createdAt: now,
      updatedAt: now,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.settings && typeof input.settings === "object"
        ? { settings: input.settings as Workflow["settings"] }
        : {}),
    };
    workflows.set(id, stored);
    return json(clone(stored));
  }

  function updateWorkflow(id: string, raw: string): Response {
    const existing = workflows.get(id);
    if (!existing) return json({ message: "Resource not found" }, 404);
    const input = parseBody(raw);
    const updated: Workflow = {
      ...existing,
      name: typeof input.name === "string" ? input.name : existing.name,
      nodes: Array.isArray(input.nodes) ? (input.nodes as Workflow["nodes"]) : existing.nodes,
      connections:
        input.connections && typeof input.connections === "object"
          ? (input.connections as Workflow["connections"])
          : existing.connections,
      updatedAt: nowIso(),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
    };
    workflows.set(id, updated);
    return json(clone(updated));
  }

  function deleteWorkflow(id: string): Response {
    if (!workflows.has(id)) return json({ message: "Resource not found" }, 404);
    workflows.delete(id);
    return json({ id });
  }

  function setActive(id: string, active: boolean): Response {
    const existing = workflows.get(id);
    if (!existing) return json({ message: "Resource not found" }, 404);
    const updated = { ...existing, active, updatedAt: nowIso() };
    workflows.set(id, updated);
    return json(clone(updated));
  }

  return {
    port: server.port!,
    captured,
    workflows,
    writes: () => captured.filter((r) => r.method !== "GET" && r.method !== "HEAD"),
    get: (id) => {
      const wf = workflows.get(id);
      return wf ? clone(wf) : undefined;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function timestamps(wf: Workflow): Pick<Workflow, "createdAt" | "updatedAt"> {
  const now = nowIso();
  return { createdAt: wf.createdAt ?? now, updatedAt: wf.updatedAt ?? now };
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
