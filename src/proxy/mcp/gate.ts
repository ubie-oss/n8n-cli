/**
 * The MCP gate: an operator's policy in front of n8n's MCP endpoint.
 *
 * Three things happen here, and only the first is cosmetic:
 *
 *   1. `tools/list` results are filtered, so a tool the policy withholds never
 *      appears in the model's context at all.
 *   2. `tools/call` on a withheld tool is refused here, without reaching n8n —
 *      hiding a tool an agent can still call is theatre.
 *   3. `tools/call` on a tool that names a workflow is refused unless that
 *      workflow matches the policy, which is the part n8n's own per-workflow
 *      toggle cannot give you: it is set in the UI, by anyone with edit rights,
 *      and never shows up in a review.
 *
 * Everything else on the MCP path — `initialize`, `notifications/*`, the
 * server-to-client `GET` stream, session teardown — is forwarded untouched.
 */

import type { EnforceLevel } from "../config.ts";
import type { Logger } from "../logging.ts";
import { forwardRequest } from "../upstream.ts";
import {
  encodeReply,
  INVALID_PARAMS,
  type JsonRpcMessage,
  parseJsonRpc,
  protocolError,
  rewriteBody,
  toolCallArguments,
  toolCallName,
  toolErrorResult,
} from "./jsonrpc.ts";
import {
  hasWorkflowScope,
  isToolAllowed,
  type McpPolicy,
  scanForWorkflowIds,
  targetWorkflowId,
} from "./policy.ts";
import type { AllowedWorkflowIndex } from "./workflow-index.ts";

export interface McpGateDeps {
  upstream: string;
  policy: McpPolicy;
  enforce: EnforceLevel;
  index: AllowedWorkflowIndex;
  logger: Logger;
  timeoutMs?: number;
  clientMiddlewares?: import("@/middleware/types.ts").ClientMiddleware[];
}

/**
 * The path n8n serves its instance-level MCP endpoint on.
 *
 * Not configurable: n8n fixes it at `/mcp-server/http` and offers no setting to
 * move it. A flag here would only be a way to point the gate at the wrong path
 * and quietly stop gating.
 */
export const MCP_PATH_PREFIX = "/mcp-server/";

/** True when this request targets the MCP endpoint the gate governs. */
export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp-server" || pathname.startsWith(MCP_PATH_PREFIX);
}

/**
 * Handles one request to the MCP endpoint.
 *
 * The body is read in full: an MCP request is a single JSON-RPC message (or a
 * small batch), not a stream, so there is nothing to lose by buffering it, and
 * the decision needs the whole thing.
 */
export async function handleMcpRequest(req: Request, deps: McpGateDeps): Promise<Response> {
  const pathname = new URL(req.url).pathname;

  // `off` keeps the route registered — so the path still forwards — while the
  // policy stops applying. Useful to switch the gate out without redeploying a
  // different route table.
  if (deps.enforce === "off") {
    return forward(req, undefined, pathname, deps);
  }

  // Only a POST carries a JSON-RPC request. GET (the server-to-client SSE
  // stream) and DELETE (session teardown) are pure transport.
  if (req.method !== "POST") {
    return forward(req, undefined, pathname, deps);
  }

  const rawJSON = await req.text();
  const parsed = parseJsonRpc(rawJSON);
  if (!parsed) {
    // Not something we can reason about; n8n can reject it on its own terms.
    return forward(req, rawJSON, pathname, deps);
  }

  const refusals: JsonRpcMessage[] = [];
  for (const message of parsed.messages) {
    const refusal = await refuse(message, pathname, deps);
    if (refusal) refusals.push(refusal);
  }

  // Under `warn` the decision is logged and the call still goes through, which
  // is how an operator finds out what a policy would break before it does.
  if (refusals.length > 0 && deps.enforce === "error") {
    if (refusals.length !== parsed.messages.length) {
      // A batch where only some calls are refused would need the allowed half
      // forwarded and the two halves recombined. Refusing the batch is the
      // honest answer, and no MCP client in practice batches tool calls.
      return jsonRpcResponse(
        parsed.messages.map(
          (m) =>
            refusals.find((r) => r.id === m.id) ??
            protocolError(m.id, INVALID_PARAMS, "batched with a call this proxy refuses"),
        ),
        parsed.isBatch,
      );
    }
    return jsonRpcResponse(refusals, parsed.isBatch);
  }

  const response = await forward(req, rawJSON, pathname, deps);

  // Only a tools/list reply needs rewriting, and only when the policy actually
  // withholds something. Everything else streams back untouched.
  //
  // Under `warn` the list is left alone as well: the point of warn is to find
  // out what the policy would break, and a client that never sees a tool cannot
  // exercise it, so the log an operator is rolling out against would stay empty.
  const listsTools = parsed.messages.some((m) => m.method === "tools/list");
  if (!listsTools || !filtersTools(deps.policy) || deps.enforce !== "error") return response;

  return filterToolsListResponse(response, deps, pathname);
}

/** Whether the policy can withhold any tool at all. */
function filtersTools(policy: McpPolicy): boolean {
  return policy.allowTools.length > 0 || policy.denyTools.length > 0;
}

/**
 * Decides whether a single JSON-RPC message is refused, returning the reply to
 * send in its place, or null to let it through.
 */
async function refuse(
  message: JsonRpcMessage,
  pathname: string,
  deps: McpGateDeps,
): Promise<JsonRpcMessage | null> {
  const tool = toolCallName(message);
  if (tool === null) return null;

  if (!isToolAllowed(deps.policy, tool)) {
    log(deps, pathname, `tool "${tool}" is not exposed by this proxy`, tool);
    // The tool was never listed, so a client calling it is off-protocol. Say so
    // as a protocol error rather than as a tool result the model will retry.
    return protocolError(message.id, INVALID_PARAMS, `Unknown tool: ${tool}`);
  }

  if (!hasWorkflowScope(deps.policy)) return null;

  const args = toolCallArguments(message);
  const target = targetWorkflowId(tool, args);

  // A tool this release knows to be workflow-scoped, called without naming one,
  // is malformed rather than broad. Refused: waving it through would mean the
  // one call the gate cannot reason about is also the one it lets past.
  if (target === null) {
    log(deps, pathname, `tool "${tool}" named no workflow`, tool);
    return toolErrorResult(
      message.id,
      `This proxy only allows ${tool} against a workflow it can identify, and this call named none.`,
    );
  }

  let sets: Awaited<ReturnType<typeof deps.index.sets>>;
  try {
    sets = await deps.index.sets();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(deps, pathname, `workflow index unavailable: ${reason}`, tool);
    // Fail closed. A gate that opens during an upstream outage is not a gate,
    // and an operator who wants the calls through has `--mcp-enforce warn`.
    return toolErrorResult(
      message.id,
      "This proxy could not verify whether that workflow is available over MCP. Try again shortly.",
    );
  }

  // Every workflow id anywhere in the arguments, not just the one the table
  // pointed at — so a parameter this release named wrong, or a tool it has
  // never heard of, cannot carry a forbidden id past the check.
  const mentioned = scanForWorkflowIds(args, sets.known);
  if (target !== undefined) mentioned.add(target);

  const forbidden = [...mentioned].filter((id) => !sets.allowed.has(id));
  if (forbidden.length === 0) return null;

  log(deps, pathname, `workflow ${forbidden.join(", ")} is out of MCP scope`, tool);
  return toolErrorResult(
    message.id,
    `Workflow ${forbidden.join(", ")} is not available over MCP. Only workflows this instance's MCP policy covers can be reached; ask the workflow's owner to bring it under that policy.`,
  );
}

/**
 * Buffers a tools/list reply and drops the tools the policy withholds.
 *
 * Buffering is safe here and only here: under Streamable HTTP a POST is
 * answered by a stream that closes once the reply is delivered, and a tool list
 * is a few kilobytes. The long-lived server-to-client stream is the `GET`, which
 * never reaches this function. Note that `--upstream-timeout` bounds the fetch,
 * not this read, so an upstream that opens a response and then stalls holds the
 * request open — the same exposure the rest of the proxy has when it reads a
 * body.
 */
async function filterToolsListResponse(
  response: Response,
  deps: McpGateDeps,
  pathname: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type");
  const body = await response.text();

  let removed = 0;
  const rewritten = rewriteBody(body, contentType, (message) => {
    const tools = message.result?.tools;
    if (!Array.isArray(tools)) return message;
    const kept = tools.filter((tool) => {
      const name = (tool as { name?: unknown })?.name;
      if (typeof name !== "string") return true;
      const allowed = isToolAllowed(deps.policy, name);
      if (!allowed) removed++;
      return allowed;
    });
    if (kept.length === tools.length) return message;
    return { ...message, result: { ...message.result, tools: kept } };
  });

  if (removed > 0) {
    log(deps, pathname, `withheld ${removed} tool(s) from tools/list`);
  }

  const headers = new Headers(response.headers);
  // The body changed length; let the runtime recompute it.
  headers.delete("content-length");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcResponse(messages: JsonRpcMessage[], isBatch: boolean): Response {
  return new Response(encodeReply(messages, isBatch), {
    // A refusal is a valid JSON-RPC reply, so the HTTP layer succeeded. MCP
    // clients read the envelope, not the status code, and a 4xx here makes
    // several of them drop the session instead of showing the model the reason.
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function forward(
  req: Request,
  body: string | undefined,
  pathname: string,
  deps: McpGateDeps,
): Promise<Response> {
  const { response, elapsedMs } = await forwardRequest(req, deps.upstream, body, {
    timeoutMs: deps.timeoutMs,
    clientMiddlewares: deps.clientMiddlewares,
  });
  deps.logger.log({
    action: "forward",
    method: req.method,
    path: pathname,
    status: response.status,
    upstreamMs: elapsedMs,
  });
  return response;
}

/**
 * Records a policy decision.
 *
 * `status` is 200 even for a refusal: the refusal travels as a JSON-RPC reply,
 * so that is genuinely what the client received, and logging a 403 nobody sent
 * would send an operator hunting for an HTTP error in their gateway logs.
 */
function log(deps: McpGateDeps, pathname: string, message: string, tool?: string): void {
  deps.logger.log({
    action: deps.enforce === "error" ? "block" : "warn",
    method: "POST",
    path: pathname,
    status: 200,
    message: `mcp: ${message}${tool ? ` (tool=${tool})` : ""}`,
  });
}
