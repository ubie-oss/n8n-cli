/**
 * Minimal MCP (Model Context Protocol) client for n8n's instance-level MCP
 * server.
 *
 * n8n exposes MCP tools at `POST /mcp-server/http` — outside `/api/v1`,
 * authenticated with a *MCP access token* (`Authorization: Bearer ...`), not
 * the API key. The transport is Streamable HTTP: one JSON-RPC message per
 * POST, optional `Mcp-Session-Id` header for the session.
 *
 * Two deployment shapes are supported, and they differ only in who holds the
 * token:
 *
 *   - direct: the CLI has the MCP access token and sends it itself.
 *   - proxy:  the CLI has no token. Its `N8N_API_URL` points at an n8n-cli
 *     `proxy`, which transparently forwards `/mcp-server/*` and injects the
 *     token on its egress (`bearer-token-inject` middleware). The CLI sends
 *     no Authorization header at all in this mode.
 *
 * Only what n8n-cli needs is implemented: `initialize`, then `tools/call`
 * for the folder-reading tools (`search_workflows`, `get_workflow_details`,
 * `search_folders`).
 */

/** JSON-RPC 2.0 request id counter — one process-wide sequence is fine. */
let nextRequestId = 1;

export interface McpClientOptions {
  /** Full MCP endpoint URL, e.g. `https://n8n.example.com/mcp-server/http`. */
  endpointUrl: string;
  /** MCP access token. Omit in proxy mode — the proxy injects it. */
  token?: string;
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

/** Derives the MCP endpoint URL from a configured API URL. */
export function deriveMcpEndpointUrl(apiUrl: string): string {
  let url = apiUrl.replace(/\/+$/, "");
  if (url.endsWith("/api/v1")) {
    url = url.slice(0, -"/api/v1".length);
  }
  return `${url}/mcp-server/http`;
}

/**
 * Calls an MCP tool and returns its parsed result.
 *
 * Result parsing follows the MCP tool-result convention: prefer
 * `structuredContent`, fall back to the first text content parsed as JSON
 * (n8n's tools emit JSON text), and finally the raw text.
 */
export class McpClient {
  private readonly endpointUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private sessionId?: string;
  private initialized = false;

  constructor(opts: McpClientOptions) {
    this.endpointUrl = opts.endpointUrl;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Calls a tool by name. Initializes the session lazily on first use. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.initialized) {
      await this.initialize();
    }

    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError) {
      throw new McpError(extractErrorText(result) ?? "tool call failed");
    }
    return parseToolResult<T>(result);
  }

  /** SearchWorkflows calls n8n's `search_workflows` tool. */
  async searchWorkflows(
    args: { limit?: number; projectId?: string; sortBy?: string } = {},
  ): Promise<{ data: Array<Record<string, unknown>>; count?: number }> {
    const result = await this.callTool<Record<string, unknown>>("search_workflows", {
      limit: args.limit ?? 200,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.sortBy ? { sortBy: args.sortBy } : {}),
    });
    const data = Array.isArray(result.data) ? result.data : [];
    return { data, count: typeof result.count === "number" ? result.count : undefined };
  }

  /** GetWorkflowDetails calls n8n's `get_workflow_details` tool. */
  async getWorkflowDetails(
    workflowId: string,
  ): Promise<{ workflow?: Record<string, unknown>; [key: string]: unknown }> {
    return this.callTool("get_workflow_details", { workflowId });
  }

  /** Sends the MCP `initialize` handshake and marks the session ready. */
  private async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "n8n-cli", version: "1.0.0" },
    });
    // The MCP spec has the client confirm the handshake before calling tools.
    // It is a notification: no id, no response — servers that do not track
    // handshakes simply answer 202 (or nothing).
    try {
      await this.notify("notifications/initialized", {});
    } catch {
      // Notification failures are not fatal: the tool call itself will carry
      // the real error if the session is somehow unusable.
    }
    this.initialized = true;
  }

  /** Sends one JSON-RPC request and returns its `result`. */
  /**
   * Sends a JSON-RPC notification (no id, no response expected). Servers
   * answer 202 or an empty body; anything readable is discarded.
   */
  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<NonNullable<JsonRpcResponse["result"]>> {
    const id = nextRequestId++;
    const body = { jsonrpc: "2.0", id, method, params };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        // Echo the session the server assigned at initialize, if any.
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      };

      let resp: Response;
      try {
        resp = await this.fetchImpl(this.endpointUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw new McpError(
          `MCP request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const sessionId = resp.headers.get("Mcp-Session-Id");
      if (sessionId) this.sessionId = sessionId;

      const text = await resp.text();

      if (resp.status === 401 || resp.status === 403) {
        throw new McpError(
          `MCP request unauthorized (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
          resp.status,
        );
      }
      if (!resp.ok) {
        throw new McpError(
          `MCP request failed (HTTP ${resp.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
          resp.status,
        );
      }

      // Streamable HTTP may answer with plain JSON or an SSE stream containing
      // the response. Handle the SSE envelope if it appears.
      const payload = extractJsonRpcPayload(text);

      if (!payload || typeof payload !== "object") {
        throw new McpError(`MCP response is not JSON-RPC: ${text.slice(0, 200)}`);
      }
      const rpcResp = payload as JsonRpcResponse;
      if (rpcResp.error) {
        throw new McpError(
          rpcResp.error.message || "MCP error",
          rpcResp.error.code,
          rpcResp.error.data,
        );
      }
      if (rpcResp.result === undefined) {
        throw new McpError("MCP response carries no result");
      }
      return rpcResp.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Parses the JSON-RPC message out of a response body: either the body itself
 * or the first `data:` line of an SSE stream.
 */
export function extractJsonRpcPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // SSE stream: JSON-RPC responses ride `data:` lines. Notifications (which
  // carry a `method` and no `id`) are skipped — the caller is waiting on a
  // response, not an event.
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const data = l.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (typeof parsed.method !== "string") return parsed;
    } catch {}
  }
  return null;
}

function parseToolResult<T>(result: NonNullable<JsonRpcResponse["result"]>): T {
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const content = result.content ?? [];
  const textItem = content.find((c) => c.type === "text" && typeof c.text === "string");
  if (textItem?.text) {
    try {
      return JSON.parse(textItem.text) as T;
    } catch {
      return textItem.text as T;
    }
  }
  return result as T;
}

function extractErrorText(result: NonNullable<JsonRpcResponse["result"]>): string | undefined {
  const content = result.content ?? [];
  const textItem = content.find((c) => c.type === "text" && typeof c.text === "string");
  return textItem?.text;
}
