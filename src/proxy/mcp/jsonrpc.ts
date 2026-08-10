/**
 * The slice of JSON-RPC 2.0 / MCP wire handling the gate needs.
 *
 * n8n's MCP endpoint speaks Streamable HTTP, which means a POST is answered
 * either with `application/json` or with an SSE stream carrying the same JSON in
 * `data:` frames. The gate has to read the request the same way in both cases,
 * and rewrite `tools/list` results without caring which shape came back.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error code for a request whose parameters the server rejects. */
export const INVALID_PARAMS = -32602;

/**
 * Parses a request body into JSON-RPC messages.
 *
 * Returns null when the body is not JSON-RPC at all — an MCP client's `GET` for
 * the server-to-client stream, a `DELETE` ending a session, or anything else
 * this proxy has no business inspecting. Callers forward those untouched.
 *
 * A batch (top-level array) is returned as its elements, and `isBatch` records
 * that so a reply can be shaped the same way.
 */
export function parseJsonRpc(raw: string): { messages: JsonRpcMessage[]; isBatch: boolean } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const messages = parsed.filter(isMessage);
    if (messages.length !== parsed.length) return null;
    return { messages, isBatch: true };
  }
  if (!isMessage(parsed)) return null;
  return { messages: [parsed], isBatch: false };
}

function isMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Name of the tool a `tools/call` targets, or null when the message is not one. */
export function toolCallName(message: JsonRpcMessage): string | null {
  if (message.method !== "tools/call") return null;
  const name = message.params?.name;
  return typeof name === "string" ? name : null;
}

/** Arguments of a `tools/call`, as an object (empty when absent or malformed). */
export function toolCallArguments(message: JsonRpcMessage): Record<string, unknown> {
  const args = message.params?.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

/**
 * Builds an MCP tool result carrying an error message.
 *
 * A refusal the model should reason about — "that workflow is not available to
 * you" — belongs here rather than in a JSON-RPC error: clients hand `isError`
 * results to the model, and hand protocol errors to their own error path, where
 * the agent never learns why.
 */
export function toolErrorResult(id: JsonRpcMessage["id"], message: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
    },
  };
}

/** Builds a JSON-RPC protocol error — for a call that should not have been possible. */
export function protocolError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Serialises a reply, matching the batch shape of the request it answers. */
export function encodeReply(messages: JsonRpcMessage[], isBatch: boolean): string {
  return JSON.stringify(isBatch ? messages : messages[0]);
}

/**
 * Rewrites every JSON-RPC message embedded in a response body, whatever
 * transport framing it arrived in.
 *
 * `application/json` bodies are parsed and re-serialised. SSE bodies are walked
 * frame by frame, rewriting only the `data:` payloads and leaving the rest of
 * the framing — `event:`, `id:`, comments, blank-line separators — byte for
 * byte, because a client's parser depends on it.
 */
export function rewriteBody(
  body: string,
  contentType: string | null,
  rewrite: (message: JsonRpcMessage) => JsonRpcMessage,
): string {
  if ((contentType ?? "").toLowerCase().includes("text/event-stream")) {
    return rewriteSse(body, rewrite);
  }

  const parsed = parseJsonRpc(body);
  if (!parsed) return body;
  return encodeReply(parsed.messages.map(rewrite), parsed.isBatch);
}

/**
 * Rewrites the `data:` payloads of an SSE body.
 *
 * Per the SSE grammar a frame's data can span several `data:` lines, which are
 * joined with newlines to form one payload. The rewrite therefore happens per
 * frame, not per line, and the result is written back as a single `data:` line
 * — legal, and simpler than trying to redistribute the JSON over the original
 * line breaks.
 */
function rewriteSse(body: string, rewrite: (message: JsonRpcMessage) => JsonRpcMessage): string {
  // Frames are separated by a blank line; \r\n is as legal as \n.
  const separator = body.includes("\r\n") ? "\r\n" : "\n";
  const frames = body.split(`${separator}${separator}`);

  const rewritten = frames.map((frame) => {
    const lines = frame.split(separator);
    const dataLines: number[] = [];
    const payload: string[] = [];

    lines.forEach((line, index) => {
      if (!line.startsWith("data:")) return;
      dataLines.push(index);
      payload.push(line.slice("data:".length).replace(/^ /, ""));
    });

    if (dataLines.length === 0) return frame;

    const parsed = parseJsonRpc(payload.join("\n"));
    if (!parsed) return frame;

    const encoded = encodeReply(parsed.messages.map(rewrite), parsed.isBatch);
    const [first, ...rest] = dataLines as [number, ...number[]];
    lines[first] = `data: ${encoded}`;
    // Drop the continuation lines; the payload now lives on the first one.
    const dropped = new Set(rest);
    return lines.filter((_, index) => !dropped.has(index)).join(separator);
  });

  return rewritten.join(`${separator}${separator}`);
}
