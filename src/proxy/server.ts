import { PROJECT_ID_HEADER, STALE_WRITE_WARNING_HEADER } from "@/api/headers.ts";
import type { Workflow } from "@/api/types.ts";
import { hasAllTags } from "@/common/tags.ts";
import { STALE_WRITE_RULE } from "@/middleware/builtin/stale-write/middleware.ts";
import { buildClientMiddlewares } from "@/middleware/client-registry.ts";
import {
  DEFAULT_CLIENT_MIDDLEWARE_CHAIN,
  registerClientBuiltins,
} from "@/middleware/client-wiring.ts";
import { runPipeline } from "@/middleware/pipeline.ts";
import { buildMiddlewares, resolveEnabledList } from "@/middleware/registry.ts";
import type {
  ClientMiddleware,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";
import { DEFAULT_SERVER_MIDDLEWARE_CHAIN, registerBuiltins } from "@/middleware/wiring.ts";
import { normalizeUpstream, type ProxyConfig, parseListenAddr } from "./config.ts";
import { DuplicateChecker } from "./duplicate.ts";
import { Logger, type ResolvedLogIdentity, resolveLogIdentity } from "./logging.ts";
import { handleMcpRequest, isMcpPath, type McpGateDeps } from "./mcp/gate.ts";
import { AllowedWorkflowIndex } from "./mcp/workflow-index.ts";
import {
  buildBadJSONResponse,
  buildDenialResponse,
  buildDuplicateResponse,
  buildErrorResponse,
} from "./response.ts";
import { evaluateBodylessPipeline } from "./rest/read-gate.ts";
import { matchWorkflowRead } from "./rest/read-router.ts";
import { matchWorkflowMutation, type WorkflowMutation } from "./rest/router.ts";
import { forwardRequest } from "./upstream.ts";

const SERVER_MIDDLEWARES_ENV_VAR = "N8N_SERVER_MIDDLEWARES";
const CLIENT_MIDDLEWARES_ENV_VAR = "N8N_CLIENT_MIDDLEWARES";

/** Response header carrying the per-request correlation id to the client. */
const REQUEST_ID_HEADER = "x-n8n-cli-request-id";

/**
 * Tracks whether middleware `prepare()` has finished so `/readyz` can flip
 * from 503 (not ready) to 200 (ready) once long-running resolvers finish.
 */
interface ReadinessState {
  status: "preparing" | "ready" | "failed";
  errors: Array<{ middleware: string; message: string }>;
}

export interface ProxyHandle {
  port: number;
  stop: () => Promise<void>;
}

interface HandlerDeps {
  upstream: string;
  config: ProxyConfig;
  logger: Logger;
  duplicates: DuplicateChecker | null;
  middlewares: ServerMiddleware[];
  clientMiddlewares: ClientMiddleware[];
  readiness: ReadinessState;
  /** Built when the operator configured an MCP policy; absent otherwise. */
  mcp: McpGateDeps | null;
  /** Whether caller identity may be included in log lines (opt-in). */
  logIdentity: boolean;
}

/** Starts the proxy server. Returns a handle so tests can stop it cleanly. */
export function startProxy(config: ProxyConfig): ProxyHandle {
  // Register builtin middleware factories. Idempotent — safe to call once
  // per `startProxy` invocation (tests call this repeatedly).
  registerBuiltins();
  registerClientBuiltins();

  const { host, port } = parseListenAddr(config.listen);
  const upstream = normalizeUpstream(config.upstream);
  const logger = new Logger(config.logFormat, config.logWriter);
  const logIdentity = config.logIdentity ?? envBool(process.env.N8N_PROXY_LOG_IDENTITY);

  // Decide which server middlewares to run. Precedence: explicit config (set
  // by the CLI from --server-middleware) > N8N_SERVER_MIDDLEWARES env var >
  // legacy default ["lint"]. Matches apply's behavior so the env-var contract
  // documented on --server-middleware ("env: N8N_SERVER_MIDDLEWARES") holds
  // for the proxy too.
  const enabled = resolveEnabledList({
    cliValue: config.middlewares?.join(","),
    env: process.env,
    envVar: SERVER_MIDDLEWARES_ENV_VAR,
    fallback: DEFAULT_SERVER_MIDDLEWARE_CHAIN,
  });

  // Stitch the legacy --enforce / --lint-config / --disable-rule flags into
  // the lint middleware's CLI options bag. This lets the existing test
  // surface keep working without callers having to change to the new flags.
  // Resolve and build the client-side (outgoing) middleware chain first —
  // project-role membership lookups run through it when listing members.
  const enabledClient = resolveEnabledList({
    cliValue: config.clientMiddlewares?.join(","),
    env: process.env,
    envVar: CLIENT_MIDDLEWARES_ENV_VAR,
    fallback: DEFAULT_CLIENT_MIDDLEWARE_CHAIN,
  });
  const clientMiddlewares = buildClientMiddlewares({
    enabled: enabledClient,
    env: process.env,
    cliOpts: config.clientMiddlewareCliOptions ?? {},
  });

  const legacyCliOpts: Record<string, unknown> = {
    lintEnforce: config.enforce,
    ...(config.lintConfigPath ? { lintConfig: config.lintConfigPath } : {}),
    ...(config.disableRules.length ? { lintDisableRule: config.disableRules } : {}),
    ...(config.middlewareCliOptions ?? {}),
    projectRoleUpstream: upstream,
    clientMiddlewares,
  };

  const middlewares = buildMiddlewares({
    enabled,
    env: process.env,
    cliOpts: legacyCliOpts,
  });

  const mcpSettings = config.mcp ?? null;
  const mcp: McpGateDeps | null = mcpSettings
    ? {
        upstream,
        policy: mcpSettings.policy,
        enforce: mcpSettings.enforce,
        index: new AllowedWorkflowIndex(
          mcpSettings.policy,
          {
            upstream,
            timeoutMs: config.upstreamTimeoutMs,
            clientMiddlewares,
          },
          mcpSettings.cacheTtlMs,
        ),
        timeoutMs: config.upstreamTimeoutMs,
        clientMiddlewares,
        middlewares,
        fetchStoredWorkflow: (id, apiKey) =>
          lookupStoredWorkflow(id, apiKey, {
            upstream,
            timeoutMs: config.upstreamTimeoutMs,
            clientMiddlewares,
          }),
        logIdentity,
      }
    : null;

  // Start resolving which workflows the policy covers now rather than inside
  // the first tool call. Not awaited, and not part of the readiness pass
  // below: a slow n8n must not hold the container back — see `prefetch()`.
  //
  // Skipped at `off`, where no request will read the result: paginating every
  // workflow at startup — and logging a credential failure for it — is a poor
  // way to honour "this gate is turned off".
  if (mcp && mcp.enforce !== "off") mcp.index.prefetch();

  // Run prepare() up front so identity-resolution / config-load failures
  // surface at startup rather than on the first request. We also track the
  // result so `/readyz` can report 503 until every middleware finishes
  // (authz, for instance, prefetches groups from a remote endpoint).
  //
  // Failures are also written to stderr as they happen so deployments that
  // don't probe `/readyz` (bare docker, local dev) still see the breakage
  // — without this the proxy would run silently in a broken state.
  const readiness: ReadinessState = { status: "preparing", errors: [] };
  const allForPrepare: Array<{ name: string; prepare?: () => unknown }> = [
    ...middlewares,
    ...clientMiddlewares,
  ];
  Promise.all(
    allForPrepare.map(async (mw) => {
      try {
        await mw.prepare?.();
        return null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`n8n-cli proxy: middleware "${mw.name}" prepare() failed: ${message}`);
        return { middleware: mw.name, message };
      }
    }),
  ).then((results) => {
    const failures = results.filter((r): r is { middleware: string; message: string } => !!r);
    if (failures.length === 0) {
      readiness.status = "ready";
    } else {
      readiness.status = "failed";
      readiness.errors = failures;
    }
  });

  // Duplicate-name detection is on by default; opt out with allowDuplicates.
  const duplicates = config.allowDuplicates
    ? null
    : new DuplicateChecker(upstream, config.duplicateTtlMs);

  const deps: HandlerDeps = {
    upstream,
    config,
    logger,
    duplicates,
    middlewares,
    clientMiddlewares,
    readiness,
    mcp,
    logIdentity,
  };

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (req) => handle(req, deps),
  });

  return {
    port: server.port ?? port,
    stop: async () => {
      await server.stop(true);
      await Promise.all([
        ...middlewares.map((m) => m.dispose?.()),
        ...clientMiddlewares.map((m) => m.dispose?.()),
      ]);
    },
  };
}

async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Internal endpoints — never forwarded. Allow GET and HEAD so load
  // balancers using HEAD probes don't accidentally hit the upstream.
  //
  // - /livez:   process is alive (always 200 once we're serving)
  // - /readyz:  middleware prepare() finished; 503 while preparing or on
  //             failure so Kubernetes / LB removes us from the pool until
  //             dependencies (authz groups fetch, lint config load, ...)
  //             are usable.
  // - /healthz: legacy generic check, kept as 200 for backward compat with
  //             existing probes. Use /livez or /readyz for new deployments.
  if (isProbeRequest(req.method, pathname)) {
    return handleProbe(req.method, pathname, deps);
  }

  // Per-request correlation id: pinned on every log line this request emits
  // and echoed to the client on the response header, so a caller can tie its
  // own records to the proxy's view of the same call.
  const requestId = crypto.randomUUID();
  const reqLog = deps.logger.child({ requestId, method: req.method, path: pathname });

  // MCP policy, when one is configured. Checked before the workflow-mutation
  // table because the two surfaces are disjoint: n8n's MCP endpoint speaks
  // JSON-RPC on its own path and never looks like a public-API write.
  if (deps.mcp && isMcpPath(pathname)) {
    const mcpLog = reqLog.child({ surface: "mcp" });
    try {
      return attachRequestId(await handleMcpRequest(req, deps.mcp, mcpLog), requestId);
    } catch (err) {
      return attachRequestId(reportError(err, req, deps, mcpLog), requestId);
    }
  }

  const mutation = matchWorkflowMutation(req.method, pathname, deps.config.routes);
  if (mutation) {
    return attachRequestId(
      await handleWorkflowMutation(
        req,
        mutation,
        pathname,
        deps,
        reqLog.child({ surface: "rest-write" }),
      ),
      requestId,
    );
  }

  return attachRequestId(
    await handleTransparentForward(req, pathname, deps, reqLog.child({ surface: "transparent" })),
    requestId,
  );
}

/** Attaches the correlation header to a response so the caller can match it to the log. */
function attachRequestId(response: Response, requestId: string): Response {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

function isProbeRequest(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname === "/healthz" || pathname === "/livez" || pathname === "/readyz";
}

function handleProbe(method: string, pathname: string, deps: HandlerDeps): Response {
  // /readyz reflects the prepare() state; everything else just says alive.
  if (pathname === "/readyz") {
    const { status, errors } = deps.readiness;
    if (status === "ready") {
      return new Response(method === "HEAD" ? null : "ready\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    const body =
      status === "preparing"
        ? "preparing\n"
        : `not ready\n${errors.map((e) => `  ${e.middleware}: ${e.message}`).join("\n")}\n`;
    return new Response(method === "HEAD" ? null : body, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response(method === "HEAD" ? null : "ok\n", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/**
 * Makes a message safe to carry in a response header.
 *
 * The text quotes a timestamp and a workflow id that came from upstream and
 * from the request path, so neither is this proxy's to trust. `Headers.set`
 * rejects control characters *and* anything outside Latin-1 — a workflow id of
 * `%E6%97%A5` is enough — and the throw would land in the forwarding try/catch,
 * turning a write upstream had already accepted into a 502 for the client.
 *
 * So the value is reduced to printable ASCII. It is a human-readable hint, not
 * a payload; the full message is in the proxy's own log either way.
 */
function headerSafe(message: string): string {
  return message.replace(/[^\x20-\x7e]/g, " ").slice(0, 512);
}

async function handleTransparentForward(
  req: Request,
  pathname: string,
  deps: HandlerDeps,
  reqLog: Logger,
): Promise<Response> {
  const read = matchWorkflowRead(req.method, pathname);
  const log = read
    ? reqLog.child({ surface: "rest-read", operation: "read", workflowId: read.id })
    : reqLog;
  let pipelineCtx: ServerMiddlewareContext | undefined;

  if (read) {
    pipelineCtx = {
      workflow: null,
      request: req,
      mode: "proxy",
      action: "read",
      workflowId: read.id,
      fetchStoredWorkflow: (id) => fetchStoredWorkflow(id, req.headers.get("x-n8n-api-key"), deps),
    };
    try {
      const verdict = await evaluateBodylessPipeline(deps.middlewares, pipelineCtx);
      if (verdict.block) {
        log.log({
          action: "block",
          status: verdict.denial?.status ?? 403,
          message: verdict.denial?.message,
          ...logIdentityFor(req, deps, pipelineCtx),
        });
        return buildDenialResponse(verdict);
      }
    } catch (err) {
      return reportError(err, req, deps, log);
    }
  }

  try {
    const { response, elapsedMs } = await forwardRequest(req, deps.upstream, undefined, {
      timeoutMs: deps.config.upstreamTimeoutMs,
      clientMiddlewares: deps.clientMiddlewares,
    });
    log.log({
      action: "forward",
      status: response.status,
      upstreamMs: elapsedMs,
      ...logIdentityFor(req, deps, pipelineCtx),
    });
    return response;
  } catch (err) {
    return reportError(err, req, deps, log);
  }
}

async function handleWorkflowMutation(
  req: Request,
  mutation: WorkflowMutation,
  pathname: string,
  deps: HandlerDeps,
  reqLog: Logger,
): Promise<Response> {
  const rawJSON = await req.text();
  const apiKey = req.headers.get("x-n8n-api-key");
  const log = reqLog.child({ operation: mutation.action, workflowId: mutation.id });

  // Only some routes carry a workflow definition. Tag assignment, delete and
  // activate carry something else (or nothing), so parsing their body as a
  // workflow — and rejecting it when that fails — would break endpoints this
  // proxy is only gating, not inspecting.
  let workflow: Workflow | null = null;
  if (mutation.bodyIsWorkflow) {
    // Malformed JSON: return 400 from the proxy itself rather than layering on
    // an upstream 400. n8n would also reject it; one clear error beats two.
    try {
      workflow = JSON.parse(rawJSON) as Workflow;
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      log.log({
        action: "block",
        status: 400,
        message: `invalid JSON: ${message}`,
        ...logIdentityFor(req, deps),
      });
      return buildBadJSONResponse(message);
    }
  }

  // Scope filter: when --tags / PROXY_FILTER_BY_TAGS is set, only workflows
  // carrying every named tag get middleware + duplicate processing. Other
  // saves are forwarded transparently so the proxy can be deployed in front
  // of an instance whose workflows are only partially under policy.
  //
  // Routes without a workflow body can't be filtered this way — the tags live
  // upstream, not in the request — so they always go through the pipeline.
  const filterTags = deps.config.filterByTags ?? [];
  if (mutation.bodyIsWorkflow && filterTags.length > 0 && !hasAllTags(workflow?.tags, filterTags)) {
    return handleSkippedMutation(req, rawJSON, workflow, filterTags, deps, log);
  }

  // Middleware pipeline (lint + authz + future policies).
  // Identity is left undefined here so each middleware can resolve from
  // its own spec; the proxy doesn't need to know which middleware needs
  // identity or which header it lives on.
  // Middleware that judges the definition must not run where there is none.
  const pipelineCtx = {
    workflow,
    // Middleware that reads a body only makes sense where one exists.
    rawJSON: mutation.bodyIsWorkflow ? rawJSON : undefined,
    request: req,
    mode: "proxy" as const,
    action: mutation.action,
    workflowId: mutation.id,
    projectId:
      mutation.action === "create" ? (req.headers.get(PROJECT_ID_HEADER) ?? undefined) : undefined,
    fetchStoredWorkflow: (id: string) => fetchStoredWorkflow(id, apiKey, deps),
  };
  const verdict = mutation.bodyIsWorkflow
    ? await runPipeline(deps.middlewares, pipelineCtx)
    : await evaluateBodylessPipeline(deps.middlewares, pipelineCtx);

  const workflowName = workflow?.name;

  if (verdict.block) {
    log.log({
      action: "block",
      status: verdict.denial?.status ?? 422,
      workflowName,
      projectId: pipelineCtx.projectId,
      violations: verdict.violations.map((v) => ({
        rule: v.rule,
        severity: v.severity,
        message: v.message,
      })),
      message: verdict.blockedBy ? `blocked by middleware ${verdict.blockedBy}` : undefined,
      ...logIdentityFor(req, deps, pipelineCtx),
    });
    return buildDenialResponse(verdict);
  }

  // Duplicate detection (creates only — updates target a specific id).
  let duplicateMatches: Awaited<ReturnType<DuplicateChecker["findByName"]>> = [];
  if (mutation.action === "create" && deps.duplicates && workflow?.name) {
    try {
      duplicateMatches = await deps.duplicates.findByName(workflow.name, apiKey);
    } catch {
      // Treat lookup failure as "no duplicate" — see DuplicateChecker for rationale.
    }
    if (duplicateMatches.length > 0 && deps.config.enforce === "error") {
      log.log({
        action: "block",
        status: 409,
        workflowName,
        message: `duplicate name: ${duplicateMatches.length} match(es)`,
        ...logIdentityFor(req, deps, pipelineCtx),
      });
      return buildDuplicateResponse(workflow.name, duplicateMatches);
    }
  }

  // Forward
  try {
    const { response, elapsedMs } = await forwardRequest(req, deps.upstream, rawJSON, {
      timeoutMs: deps.config.upstreamTimeoutMs,
      clientMiddlewares: deps.clientMiddlewares,
    });
    // Counted over lint's own violations only. A stale write is reported on its
    // own header below, and folding it in here would make it indistinguishable
    // from a lint failure — a CI step gating on `x-n8n-lint-errors`, which is
    // the documented way to roll lint out, would start failing builds for
    // writes that warn mode deliberately chose not to block, and blame lint.
    const lintViolations = verdict.violations.filter((v) => !v.rule.startsWith(STALE_WRITE_RULE));
    if (lintViolations.length > 0) {
      const errCount = lintViolations.filter((v) => v.severity === "error" || !v.severity).length;
      response.headers.set("x-n8n-lint-violations", String(lintViolations.length));
      response.headers.set("x-n8n-lint-errors", String(errCount));
    }
    if (duplicateMatches.length > 0) {
      response.headers.set("x-n8n-duplicate-warning", String(duplicateMatches.length));
    }
    // A stale write that reached this point ran under `enforce: warn`. Say so
    // out of band, the way the duplicate check does, so a client can notice it
    // reverted something without the write having been refused.
    const staleWrites = verdict.violations.filter((v) => v.rule === STALE_WRITE_RULE);
    if (staleWrites.length > 0) {
      response.headers.set(
        STALE_WRITE_WARNING_HEADER.toLowerCase(),
        headerSafe(staleWrites[0]?.message ?? "stale write"),
      );
    }
    const action = verdict.violations.length > 0 || duplicateMatches.length > 0 ? "warn" : "pass";
    log.log({
      action,
      status: response.status,
      upstreamMs: elapsedMs,
      workflowName,
      projectId: pipelineCtx.projectId,
      violations: verdict.violations.length
        ? verdict.violations.map((v) => ({
            rule: v.rule,
            severity: v.severity,
            message: v.message,
          }))
        : undefined,
      message:
        duplicateMatches.length > 0
          ? `duplicate name: ${duplicateMatches.length} upstream match(es)`
          : undefined,
      ...logIdentityFor(req, deps, pipelineCtx),
    });
    return response;
  } catch (err) {
    return reportError(err, req, deps, log);
  }
}

/**
 * Reads the stored state of a workflow from upstream, for middleware that must
 * not trust the request body (an ACL the caller can rewrite in the same call
 * grants nothing).
 *
 * Runs under the caller's own API key when they sent one, so this never
 * escalates privileges — same reasoning as the duplicate-name lookup. The
 * client middleware chain applies, so IAP/API-key injection works here too.
 *
 * Returns null when upstream says the workflow doesn't exist; throws on
 * anything else so the caller can apply its own fail-open/closed policy rather
 * than mistaking an outage for "no ACL".
 */
interface StoredWorkflowLookup {
  upstream: string;
  timeoutMs?: number;
  clientMiddlewares: ClientMiddleware[];
}

async function lookupStoredWorkflow(
  id: string,
  apiKey: string | null,
  lookup: StoredWorkflowLookup,
): Promise<Workflow | null> {
  const url = `${lookup.upstream}/api/v1/workflows/${encodeURIComponent(id)}`;
  const headers = new Headers({ accept: "application/json" });
  if (apiKey) headers.set("x-n8n-api-key", apiKey);
  const { response } = await forwardRequest(
    new Request(url, { method: "GET", headers }),
    lookup.upstream,
    undefined,
    {
      timeoutMs: lookup.timeoutMs,
      clientMiddlewares: lookup.clientMiddlewares,
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`upstream returned HTTP ${response.status} for workflow ${id}`);
  }
  return (await response.json()) as Workflow;
}

async function fetchStoredWorkflow(
  id: string,
  apiKey: string | null,
  deps: HandlerDeps,
): Promise<Workflow | null> {
  return lookupStoredWorkflow(id, apiKey, {
    upstream: deps.upstream,
    timeoutMs: deps.config.upstreamTimeoutMs,
    clientMiddlewares: deps.clientMiddlewares,
  });
}

function reportError(err: unknown, req: Request, deps: HandlerDeps, reqLog: Logger): Response {
  const message = err instanceof Error ? err.message : String(err);
  reqLog.log({
    action: "error",
    status: 502,
    message,
    ...logIdentityFor(req, deps),
  });
  return buildErrorResponse(message);
}

/**
 * Forwards a workflow mutation that fell outside the configured tag filter.
 * No middleware runs, no duplicate check fires — the proxy logs the skip and
 * passes the body to upstream verbatim.
 */
async function handleSkippedMutation(
  req: Request,
  rawJSON: string,
  workflow: Workflow | null,
  filterTags: string[],
  deps: HandlerDeps,
  reqLog: Logger,
): Promise<Response> {
  try {
    const { response, elapsedMs } = await forwardRequest(req, deps.upstream, rawJSON, {
      timeoutMs: deps.config.upstreamTimeoutMs,
      clientMiddlewares: deps.clientMiddlewares,
    });
    reqLog.log({
      action: "forward",
      status: response.status,
      upstreamMs: elapsedMs,
      workflowName: workflow?.name,
      message: `skipped by tag filter (requires: ${filterTags.join(", ")})`,
      ...logIdentityFor(req, deps),
    });
    return response;
  } catch (err) {
    return reportError(err, req, deps, reqLog);
  }
}

/**
 * Resolves caller identity for a log line, honoring the `--log-identity`
 * opt-in. Returns an empty object when disabled so call sites can spread it
 * unconditionally.
 */
function logIdentityFor(
  req: Request,
  deps: HandlerDeps,
  pipeline?: ServerMiddlewareContext,
): ResolvedLogIdentity | Record<string, never> {
  if (!deps.logIdentity) return {};
  return resolveLogIdentity(req, pipeline) ?? {};
}

/** Parses an env boolean ("1" / "true" / "yes" are true). */
function envBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === "1" || value === "true" || value === "yes";
}
