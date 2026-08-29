import { afterEach, describe, expect, test } from "bun:test";
import {
  deriveMcpEndpointUrl,
  extractJsonRpcPayload,
  McpClient,
  McpError,
} from "../../src/api/mcp-client.ts";

/**
 * The MCP client is the only bridge to workflow folder assignments — the
 * public REST API cannot report them. These tests pin the JSON-RPC transport
 * contract: the handshake, session handling, both authentication modes
 * (CLI-held token vs. proxy-injected token), and result parsing.
 */

type Handler = (input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}) => Response | Promise<Response>;

function clientWithHandler(
  handler: Handler,
  token?: string,
): {
  client: McpClient;
  requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
} {
  const requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ headers, body });
    return handler({ url: String(input), method: init?.method ?? "GET", headers, body });
  }) as typeof fetch;

  const client = new McpClient({
    endpointUrl: "https://n8n.example.com/mcp-server/http",
    ...(token ? { token } : {}),
    fetchImpl,
  });
  return { client, requests };
}

const rpcResult = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });

describe("deriveMcpEndpointUrl", () => {
  test("strips /api/v1 and appends the MCP path", () => {
    expect(deriveMcpEndpointUrl("https://n8n.example.com/api/v1")).toBe(
      "https://n8n.example.com/mcp-server/http",
    );
  });

  test("tolerates trailing slashes and a missing /api/v1", () => {
    expect(deriveMcpEndpointUrl("https://n8n.example.com/api/v1/")).toBe(
      "https://n8n.example.com/mcp-server/http",
    );
    expect(deriveMcpEndpointUrl("https://n8n.example.com/")).toBe(
      "https://n8n.example.com/mcp-server/http",
    );
  });

  test("does not strip a nested /api/v1 inside the host path", () => {
    // Only the trailing /api/v1 counts — a gateway path that happens to
    // contain it elsewhere must survive.
    expect(deriveMcpEndpointUrl("https://gw.example.com/api/v1/n8n/api/v1")).toBe(
      "https://gw.example.com/api/v1/n8n/mcp-server/http",
    );
  });
});

describe("extractJsonRpcPayload", () => {
  test("parses a plain JSON body", () => {
    expect(extractJsonRpcPayload('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  test("parses the data line of an SSE stream", () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(extractJsonRpcPayload(sse)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  });

  test("returns null for an empty body", () => {
    expect(extractJsonRpcPayload("")).toBeNull();
  });
});

describe("McpClient transport", () => {
  afterEach(() => {});

  test("initializes once, then calls the tool with the session id echoed", async () => {
    let call = 0;
    const { client, requests } = clientWithHandler(({ body }) => {
      call++;
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18" },
          }),
          { status: 200, headers: { "Mcp-Session-Id": "session-7" } },
        );
      }
      return rpcResult(body.id, { structuredContent: { data: [], count: 0 } });
    });

    await client.searchWorkflows();
    await client.searchWorkflows();

    // initialize → notifications/initialized → two tool calls
    expect(call).toBe(4);
    expect(requests[0]?.body.method).toBe("initialize");
    expect(requests[1]?.body.method).toBe("notifications/initialized");
    // The notification carries no id (JSON-RPC notification semantics).
    expect(requests[1]?.body.id).toBeUndefined();
    expect(requests[2]?.body.method).toBe("tools/call");
    expect(requests[2]?.headers["mcp-session-id"]).toBe("session-7");
    expect(requests[3]?.headers["mcp-session-id"]).toBe("session-7");
    const params = requests[2]?.body.params as { name: string; arguments: Record<string, unknown> };
    expect(params.name).toBe("search_workflows");
  });

  test("direct mode sends the Bearer token; proxy mode sends no Authorization at all", async () => {
    const direct = clientWithHandler(
      ({ body }) => rpcResult(body.id, { structuredContent: { data: [], count: 0 } }),
      "mcp-secret",
    );
    await direct.client.searchWorkflows();
    expect(direct.requests[0]?.headers.authorization).toBe("Bearer mcp-secret");

    const proxy = clientWithHandler(({ body }) =>
      rpcResult(body.id, { structuredContent: { data: [], count: 0 } }),
    );
    await proxy.client.searchWorkflows();
    // In proxy mode the CLI must not carry an Authorization header: the proxy
    // injects the token on its egress for /mcp-server/*.
    expect(proxy.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("prefers structuredContent, falls back to JSON text content", async () => {
    const structured = clientWithHandler(({ body }) =>
      rpcResult(body.id, { structuredContent: { data: [{ id: "wf1" }], count: 1 } }),
    );
    const a = await structured.client.searchWorkflows();
    expect(a.data[0]?.id).toBe("wf1");

    const textual = clientWithHandler(({ body }) =>
      rpcResult(body.id, {
        content: [{ type: "text", text: '{"data":[{"id":"wf2"}],"count":1}' }],
      }),
    );
    const b = await textual.client.searchWorkflows();
    expect(b.data[0]?.id).toBe("wf2");
  });

  test("a JSON-RPC error and an isError tool result both raise McpError", async () => {
    const erring = clientWithHandler(
      ({ body }) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "no such tool" },
          }),
          {
            status: 200,
          },
        ),
    );
    expect(erring.client.searchWorkflows()).rejects.toBeInstanceOf(McpError);

    const failed = clientWithHandler(({ body }) =>
      rpcResult(body.id, {
        isError: true,
        content: [{ type: "text", text: "folder not licensed" }],
      }),
    );
    expect(failed.client.searchWorkflows()).rejects.toThrow("folder not licensed");
  });

  test("an HTTP 401 raises an unauthorized McpError (wrong or missing token)", async () => {
    const { client } = clientWithHandler(() => new Response("Unauthorized", { status: 401 }));
    try {
      await client.searchWorkflows();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(401);
    }
  });

  test("an SSE-framed response is unwrapped", async () => {
    const { client } = clientWithHandler(
      ({ body }) =>
        new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { structuredContent: { data: [{ id: "wf-sse" }], count: 1 } },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const result = await client.searchWorkflows();
    expect(result.data[0]?.id).toBe("wf-sse");
  });
});
