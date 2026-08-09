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
import { hasWorkflowScope, isToolAllowed, type McpPolicy, targetWorkflowId } from "./policy.ts";
import type { AllowedWorkflowIndex } from "./workflow-index.ts";

export interface McpGateDeps {
  upstream: string;
  policy: McpPolicy;
  enforce: EnforceLevel;
  index: AllowedWorkflowIndex;
  logger: Logger;
  timeoutMs?: number;
  clientMiddlewares?: import("@/middleware/types.ts").ClientMiddleware[];
  /**
   * What to do when the workflow index cannot be read. `deny` (default) refuses
   * the call; `allow` forwards it. Denying is right for a gate whose whole job
   * is to bound what an agent can reach, but an operator running the gate for
   * tidiness rather than safety may prefer the opposite.
   */
  onIndexError?: "deny" | "allow";
}

/** True when this request targets the MCP endpoint the gate governs. */
export function isMcpPath(pathname: string, pathPrefix: string): boolean {
  return pathname === stripTrailingSlash(pathPrefix) || pathname.startsWith(pathPrefix);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

  const target = targetWorkflowId(deps.policy, tool, toolCallArguments(message));
  if (target === undefined) return null;

  if (target === null) {
    if (deps.policy.onMissingTarget === "allow") return null;
    log(deps, pathname, `tool "${tool}" named no workflow`, tool);
    return toolErrorResult(
      message.id,
      `This proxy only allows ${tool} against a workflow it can identify, and this call named none.`,
    );
  }

  let allowed: boolean;
  try {
    allowed = await deps.index.isAllowed(target);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(deps, pathname, `workflow index unavailable: ${reason}`, tool);
    if ((deps.onIndexError ?? "deny") === "allow") return null;
    return toolErrorResult(
      message.id,
      "This proxy could not verify whether that workflow is available over MCP. Try again shortly.",
    );
  }

  if (allowed) return null;

  log(deps, pathname, `workflow ${target} is out of MCP scope`, tool);
  return toolErrorResult(
    message.id,
    `Workflow ${target} is not available over MCP. Only workflows this instance's MCP policy covers can be reached; ask the workflow's owner to bring it under that policy.`,
  );
}

/** Buffers a tools/list reply and drops the tools the policy withholds. */
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
