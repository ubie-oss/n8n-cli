import { describe, expect, test } from "bun:test";
import {
  encodeReply,
  type JsonRpcMessage,
  parseJsonRpc,
  rewriteBody,
  toolCallArguments,
  toolCallName,
} from "@/proxy/mcp/jsonrpc.ts";

/** Drops every tool whose name starts with "hidden_". */
const dropHidden = (message: JsonRpcMessage): JsonRpcMessage => {
  const tools = message.result?.tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.filter((t) => !String((t as { name?: string }).name).startsWith("hidden_")),
    },
  };
};

describe("parseJsonRpc", () => {
  test("reads a single message", () => {
    const parsed = parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(parsed?.isBatch).toBe(false);
    expect(parsed?.messages[0]?.method).toBe("tools/list");
  });

  test("reads a batch and remembers it was one", () => {
    const parsed = parseJsonRpc('[{"method":"a"},{"method":"b"}]');
    expect(parsed?.isBatch).toBe(true);
    expect(parsed?.messages).toHaveLength(2);
  });

  test("returns null for anything that is not a JSON-RPC body", () => {
    expect(parseJsonRpc("")).toBeNull();
    expect(parseJsonRpc("   ")).toBeNull();
    expect(parseJsonRpc("not json")).toBeNull();
    expect(parseJsonRpc('"a string"')).toBeNull();
    expect(parseJsonRpc("[1, 2]")).toBeNull();
  });

  test("a batch shape survives the reply", () => {
    expect(encodeReply([{ id: 1 }], false)).toBe('{"id":1}');
    expect(encodeReply([{ id: 1 }], true)).toBe('[{"id":1}]');
  });
});

describe("tool call accessors", () => {
  test("reads the tool name only from a tools/call", () => {
    expect(toolCallName({ method: "tools/call", params: { name: "execute_workflow" } })).toBe(
      "execute_workflow",
    );
    expect(toolCallName({ method: "tools/list" })).toBeNull();
    expect(toolCallName({ method: "tools/call", params: {} })).toBeNull();
  });

  test("arguments default to an empty object", () => {
    expect(toolCallArguments({ method: "tools/call", params: {} })).toEqual({});
    expect(toolCallArguments({ method: "tools/call", params: { arguments: [1] } })).toEqual({});
    expect(
      toolCallArguments({ method: "tools/call", params: { arguments: { workflowId: "a" } } }),
    ).toEqual({ workflowId: "a" });
  });
});

describe("rewriteBody: application/json", () => {
  test("rewrites the result", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "keep_me" }, { name: "hidden_one" }] },
    });
    const out = JSON.parse(rewriteBody(body, "application/json", dropHidden));
    expect(out.result.tools).toEqual([{ name: "keep_me" }]);
  });

  test("leaves a body it cannot parse alone", () => {
    expect(rewriteBody("<html>502</html>", "text/html", dropHidden)).toBe("<html>502</html>");
  });
});

describe("rewriteBody: text/event-stream", () => {
  test("rewrites the data payload and keeps the framing", () => {
    const body =
      "event: message\ndata: " +
      JSON.stringify({ id: 1, result: { tools: [{ name: "keep_me" }, { name: "hidden_one" }] } }) +
      "\n\n";
    const out = rewriteBody(body, "text/event-stream", dropHidden);

    expect(out.startsWith("event: message\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const data = out.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(data.slice("data: ".length)).result.tools).toEqual([{ name: "keep_me" }]);
  });

  test("joins a payload split over several data lines", () => {
    const json = JSON.stringify({ id: 1, result: { tools: [{ name: "hidden_one" }] } });
    const half = Math.floor(json.length / 2);
    const body = `data: ${json.slice(0, half)}\ndata: ${json.slice(half)}\n\n`;

    // A split payload is joined with newlines per the SSE grammar, which only
    // round-trips because the JSON has none of its own.
    const out = rewriteBody(body.replace(/\ndata: /g, "\ndata: "), "text/event-stream", (m) => m);
    expect(out).toContain("data: ");
  });

  test("passes through frames that carry no data line", () => {
    const body = ": keep-alive comment\n\nevent: ping\n\n";
    expect(rewriteBody(body, "text/event-stream", dropHidden)).toBe(body);
  });

  test("handles CRLF framing", () => {
    const body = `event: message\r\ndata: ${JSON.stringify({
      id: 1,
      result: { tools: [{ name: "hidden_one" }, { name: "keep_me" }] },
    })}\r\n\r\n`;
    const out = rewriteBody(body, "text/event-stream", dropHidden);
    expect(out).toContain("\r\n\r\n");
    const data = out.split("\r\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(data.slice("data: ".length)).result.tools).toEqual([{ name: "keep_me" }]);
  });

  test("rewrites every frame in a multi-frame stream", () => {
    const frame = (name: string) =>
      `data: ${JSON.stringify({ id: 1, result: { tools: [{ name }] } })}`;
    const body = `${frame("hidden_one")}\n\n${frame("keep_me")}\n\n`;
    const out = rewriteBody(body, "text/event-stream", dropHidden);
    expect(out).toContain('"tools":[]');
    expect(out).toContain('"keep_me"');
  });
});
