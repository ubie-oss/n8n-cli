import type { Workflow } from "@/api/types.ts";

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
        if (method === "DELETE") return deleteWorkflow(id);
      }
      if (sub === "activate" && method === "POST") return setActive(id, true);
      if (sub === "deactivate" && method === "POST") return setActive(id, false);
      if (sub === "tags" && method === "PUT") return getWorkflow(id);
    }

    return json({ message: "Not found" }, 404);
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
      data: page.map(clone),
      nextCursor: next < items.length ? String(next) : null,
    });
  }

  function getWorkflow(id: string): Response {
    const wf = workflows.get(id);
    if (!wf) return json({ message: "Resource not found" }, 404);
    return json(clone(wf));
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
