/**
 * The MCP gate: an operator's policy in front of n8n's MCP endpoint.
 *
 * Four things happen here, and only the first is cosmetic:
 *
 *   1. `tools/list` results are filtered, so a tool the policy withholds never
 *      appears in the model's context at all.
 *   2. `tools/call` on a withheld tool is refused here, without reaching n8n —
 *      hiding a tool an agent can still call is theatre.
 *   3. `tools/call` on a tool that names a workflow is refused unless that
 *      workflow matches the policy, which is the part n8n's own per-workflow
 *      toggle cannot give you: it is set in the UI, by anyone with edit rights,
 *      and never shows up in a review.
 *   4. `search_workflows` results are filtered against that same policy, so the
 *      set an agent can see is the set it can run.
 *
 * Everything else on the MCP path — `initialize`, `notifications/*`, the
 * server-to-client `GET` stream, session teardown — is forwarded untouched.
 */

import type { EnforceLevel } from "../config.ts";
import type { Logger } from "../logging.ts";
import { forwardRequest } from "../upstream.ts";
import {
  ENTRY_TOOL_DEFINITION,
  ENTRY_TOOL_NAME,
  entryToolResult,
  publishesEntryTool,
} from "./entry-tool.ts";
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
import { type AllowedWorkflowIndex, explainRefusal, type WorkflowFacts } from "./workflow-index.ts";

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

  // Answered here, never forwarded: n8n has no such tool. Before the refusal
  // pass, because the same workflow scope decides both and this needs the facts
  // rather than a yes/no.
  if (deps.enforce === "error" && publishesEntryTool(deps.policy)) {
    const answered = await answerEntryTool(parsed, pathname, deps);
    if (answered) return answered;
  }

  const refusals: JsonRpcMessage[] = [];
  for (const message of parsed.messages) {
    const refusal = await refuse(message, pathname, deps);
    if (refusal) refusals.push(refusal);
  }

  // Narrow a discovery call rather than refusing it. `search_workflows` takes a
  // `tags` filter with AND semantics — the same semantics as the policy — so
  // adding the policy's tags to whatever the agent asked for can only shrink
  // the result. Without this the agent still sees the name and description of
  // every workflow the token's owner can read, which is the one part of the
  // listing surface n8n gives no way to close.
  const narrowedJSON =
    refusals.length === 0 && deps.enforce === "error"
      ? narrowSearchArguments(parsed, deps.policy)
      : null;

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

  const response = await forward(req, narrowedJSON ?? rawJSON, pathname, deps);

  // Under `warn` nothing is rewritten: the point of warn is to find out what
  // the policy would break, and a client that never sees a tool or a workflow
  // cannot exercise it, so the log an operator is rolling out against would
  // stay empty.
  if (deps.enforce !== "error") return response;

  const listsTools = parsed.messages.some((m) => m.method === "tools/list");
  const tools = listsTools && (filtersTools(deps.policy) || publishesEntryTool(deps.policy));
  const searchIds = hasWorkflowScope(deps.policy)
    ? searchCallIds(parsed.messages)
    : new Set<string | number>();
  if (!tools && searchIds.size === 0) return response;

  return filterResponse(response, deps, pathname, { tools, searchIds });
}

/**
 * Answers `get_workflow_entry` without going upstream, or returns null when the
 * request does not call it.
 *
 * A batch that mixes it with other calls is not split — the other half would
 * still have to be forwarded and the two recombined, for a case no MCP client
 * produces. Those fall through, and n8n rejects the unknown tool on its own
 * terms, which is at least an honest answer.
 */
async function answerEntryTool(
  parsed: { messages: JsonRpcMessage[]; isBatch: boolean },
  pathname: string,
  deps: McpGateDeps,
): Promise<Response | null> {
  if (!parsed.messages.every((m) => toolCallName(m) === ENTRY_TOOL_NAME)) return null;

  let sets: Awaited<ReturnType<typeof deps.index.sets>>;
  try {
    sets = await deps.index.sets();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(deps, pathname, `workflow index unavailable: ${reason}`, ENTRY_TOOL_NAME);
    return jsonRpcResponse(
      parsed.messages.map((m) =>
        toolErrorResult(
          m.id,
          "This proxy could not verify whether that workflow is available over MCP. Try again shortly.",
        ),
      ),
      parsed.isBatch,
    );
  }

  const replies = parsed.messages.map((message) => {
    const id = toolCallArguments(message).workflowId;
    if (typeof id !== "string" || id === "") {
      return toolErrorResult(message.id, `${ENTRY_TOOL_NAME} requires a workflowId.`);
    }
    if (!sets.allowed.has(id)) {
      log(deps, pathname, `workflow out of MCP scope: ${id}`, ENTRY_TOOL_NAME);
      return toolErrorResult(
        message.id,
        `Not available over MCP: ${id} (${explainRefusal(deps.policy, sets.facts.get(id))}).`,
      );
    }
    // `allowed` is built from `facts`, so the lookup cannot miss.
    return entryToolResult(message.id, sets.facts.get(id) as WorkflowFacts);
  });

  return jsonRpcResponse(replies, parsed.isBatch);
}

/**
 * Ids of the `search_workflows` calls in a request.
 *
 * The reply to a `tools/call` does not name the tool, and `{data, count}` is the
 * envelope several n8n tools share — so the replies to filter are identified by
 * the id they answer, not by their shape.
 */
function searchCallIds(messages: JsonRpcMessage[]): Set<string | number> {
  const ids = new Set<string | number>();
  for (const message of messages) {
    if (toolCallName(message) !== "search_workflows") continue;
    if (typeof message.id === "string" || typeof message.id === "number") ids.add(message.id);
  }
  return ids;
}

/**
 * Adds the policy's tags to a `search_workflows` call, or returns null when
 * there is nothing to add.
 *
 * Only tags: the entry-path rule has no equivalent argument upstream. That is
 * why this is an optimisation and not the enforcement — narrowing the request
 * saves n8n from serving rows that would be dropped anyway, and
 * `filterResponse` is what actually decides the listing.
 */
function narrowSearchArguments(
  parsed: { messages: JsonRpcMessage[]; isBatch: boolean },
  policy: McpPolicy,
): string | null {
  if (policy.workflowTags.length === 0) return null;

  let changed = false;
  const messages = parsed.messages.map((message) => {
    if (toolCallName(message) !== "search_workflows") return message;
    const args = toolCallArguments(message);
    const asked = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === "string")
      : [];
    const merged = [...new Set([...asked, ...policy.workflowTags])];
    if (merged.length === asked.length) return message;
    changed = true;
    return {
      ...message,
      params: { ...message.params, arguments: { ...args, tags: merged } },
    };
  });

  return changed ? encodeReply(messages, parsed.isBatch) : null;
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
  const mentioned = scanForWorkflowIds(args, new Set(sets.facts.keys()));
  if (target !== undefined) mentioned.add(target);

  const forbidden = [...mentioned].filter((id) => !sets.allowed.has(id));
  if (forbidden.length === 0) return null;

  // Name the reason. An agent told only "no" retries; one told the entry
  // trigger declares no path can report something its user can act on.
  const detail = forbidden
    .map((id) => `${id} (${explainRefusal(deps.policy, sets.facts.get(id))})`)
    .join("; ");

  log(deps, pathname, `workflow out of MCP scope: ${detail}`, tool);
  return toolErrorResult(
    message.id,
    `Not available over MCP: ${detail}. Note that every workflow id anywhere in the arguments is ` +
      "checked, so this may name one the call merely referenced — a sub-workflow, say — rather " +
      "than the one it targeted. Ask the owner to bring it under this instance's MCP policy.",
  );
}

/**
 * Buffers a reply and drops what the policy withholds — tools from a
 * `tools/list`, workflows from a `search_workflows`.
 *
 * The listing half is the one n8n gives no way to close. `search_workflows`
 * returns the name and description of every workflow the token's owner can
 * read, and its only relevant filter is `tags` — so a policy written as a path
 * convention has nothing to push upstream, and the result has to be narrowed on
 * the way back. Doing it here is what makes "visible" and "executable" the same
 * set, whichever predicate the policy is written in.
 *
 * Buffering is safe here and only here: under Streamable HTTP a POST is
 * answered by a stream that closes once the reply is delivered, and both a tool
 * list and a page of search results are a few kilobytes. The long-lived
 * server-to-client stream is the `GET`, which never reaches this function. Note
 * that `--upstream-timeout` bounds the fetch, not this read, so an upstream that
 * opens a response and then stalls holds the request open — the same exposure
 * the rest of the proxy has when it reads a body.
 */
async function filterResponse(
  response: Response,
  deps: McpGateDeps,
  pathname: string,
  plan: { tools: boolean; searchIds: Set<string | number> },
): Promise<Response> {
  // By now `refuse()` has already resolved the index for any workflow-scoped
  // call in this request, so this is a cache read. It can still fail on a
  // request whose only tool call is the search itself.
  let allowed: ReadonlySet<string> | null = null;
  if (plan.searchIds.size > 0) {
    try {
      allowed = (await deps.index.sets()).allowed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(deps, pathname, `workflow index unavailable, withholding search results: ${reason}`);
    }
  }

  const contentType = response.headers.get("content-type");
  const body = await response.text();

  let removedTools = 0;
  let removedWorkflows = 0;
  const rewritten = rewriteBody(body, contentType, (message) => {
    if (plan.tools && Array.isArray(message.result?.tools)) {
      const tools = message.result.tools;
      const kept = tools.filter((tool) => {
        const name = (tool as { name?: unknown })?.name;
        if (typeof name !== "string") return true;
        const ok = isToolAllowed(deps.policy, name);
        if (!ok) removedTools++;
        return ok;
      });
      // Published beside n8n's own, never in place of one: this proxy adds a
      // tool, it does not reshape what n8n serves.
      const published = publishesEntryTool(deps.policy) ? [...kept, ENTRY_TOOL_DEFINITION] : kept;
      if (published.length === tools.length) return message;
      return { ...message, result: { ...message.result, tools: published } };
    }

    if (message.id === undefined || message.id === null || !plan.searchIds.has(message.id)) {
      return message;
    }
    if (!allowed) {
      // Fail closed, like a refused call: an unfiltered listing is the leak
      // this function exists to prevent.
      return toolErrorResult(
        message.id,
        "This proxy could not verify which workflows are available over MCP. Try again shortly.",
      );
    }
    return filterSearchResult(message, allowed, (n) => {
      removedWorkflows += n;
    });
  });

  if (removedTools > 0) log(deps, pathname, `withheld ${removedTools} tool(s) from tools/list`);
  if (removedWorkflows > 0) {
    log(deps, pathname, `withheld ${removedWorkflows} workflow(s) from search_workflows`);
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

/**
 * Drops out-of-policy workflows from a `search_workflows` result.
 *
 * n8n sends the same `{data, count}` payload twice — once as `structuredContent`
 * and once JSON-encoded in a text content block — and a client may read either.
 * Both are rewritten, or the names filtered out of one arrive through the other.
 */
function filterSearchResult(
  message: JsonRpcMessage,
  allowed: ReadonlySet<string>,
  count: (removed: number) => void,
): JsonRpcMessage {
  const result = message.result;
  if (!result) return message;

  const next: Record<string, unknown> = { ...result };
  let changed = false;
  let removed = 0;

  const structured = filterPayload(result.structuredContent, allowed);
  if (structured) {
    next.structuredContent = structured.payload;
    removed = Math.max(removed, structured.removed);
    changed = true;
  }

  if (Array.isArray(result.content)) {
    const content = result.content.map((block) => {
      const text = (block as { text?: unknown })?.text;
      if (typeof text !== "string") return block;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return block;
      }
      const filtered = filterPayload(parsed, allowed);
      if (!filtered) return block;
      removed = Math.max(removed, filtered.removed);
      changed = true;
      return { ...(block as object), text: JSON.stringify(filtered.payload) };
    });
    if (changed) next.content = content;
  }

  if (!changed) return message;
  count(removed);
  return { ...message, result: next };
}

/**
 * Filters one `{data, count}` payload, or returns null when it is not one.
 *
 * An entry whose `id` is not an allowed workflow goes, and so does one carrying
 * no usable id: the point is that nothing reaches the model that it could not
 * then execute, and an entry the gate cannot identify is not identifiable at
 * `tools/call` time either.
 *
 * `count` is replaced by the number of rows that survived, not decremented by
 * the number dropped. Measured against a live instance: n8n reports the total
 * number of matches, not the size of the page in hand, so a page of 100 that
 * keeps 1 came back saying 1385 — which tells the model both to keep paging
 * after rows it will never be shown, and roughly how many workflows are being
 * withheld from it. The rows and the number now say the same thing.
 *
 * The cost is that a later page's rows are not counted, so `count` reads as a
 * floor rather than a total. That is the safe direction: this gate exists to
 * not over-report.
 */
function filterPayload(
  payload: unknown,
  allowed: ReadonlySet<string>,
): { payload: Record<string, unknown>; removed: number } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.data)) return null;

  const kept = record.data.filter((item) => {
    const id = (item as { id?: unknown })?.id;
    return typeof id === "string" && allowed.has(id);
  });
  const removed = record.data.length - kept.length;
  if (removed === 0) return null;

  const next: Record<string, unknown> = { ...record, data: kept };
  if (typeof record.count === "number") next.count = kept.length;
  return { payload: next, removed };
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
