import type { Workflow } from "@/api/types.ts";
import { runPipeline } from "@/middleware/pipeline.ts";
import { buildMiddlewares, resolveEnabledList } from "@/middleware/registry.ts";
import type { PreWriteMiddleware } from "@/middleware/types.ts";
import { DEFAULT_MIDDLEWARE_CHAIN, registerBuiltins } from "@/middleware/wiring.ts";
import { normalizeUpstream, type ProxyConfig, parseListenAddr } from "./config.ts";
import { DuplicateChecker } from "./duplicate.ts";
import { Logger } from "./logging.ts";
import {
  buildBadJSONResponse,
  buildDenialResponse,
  buildDuplicateResponse,
  buildErrorResponse,
} from "./response.ts";
import { matchWorkflowMutation, type WorkflowMutation } from "./rest/router.ts";
import { forwardRequest } from "./upstream.ts";

export interface ProxyHandle {
  port: number;
  stop: () => Promise<void>;
}

interface HandlerDeps {
  upstream: string;
  config: ProxyConfig;
  logger: Logger;
  duplicates: DuplicateChecker | null;
  middlewares: PreWriteMiddleware[];
}

/** Starts the proxy server. Returns a handle so tests can stop it cleanly. */
export function startProxy(config: ProxyConfig): ProxyHandle {
  // Register builtin middleware factories. Idempotent — safe to call once
  // per `startProxy` invocation (tests call this repeatedly).
  registerBuiltins();

  const { host, port } = parseListenAddr(config.listen);
  const upstream = normalizeUpstream(config.upstream);
  const logger = new Logger(config.logFormat);

  // Decide which middlewares to run. Defaults to ["lint"] when the caller
  // hasn't configured one, preserving legacy behavior bit-for-bit.
  const enabled = config.middlewares?.length ? config.middlewares : DEFAULT_MIDDLEWARE_CHAIN;

  // Stitch the legacy --enforce / --lint-config / --disable-rule flags into
  // the lint middleware's CLI options bag. This lets the existing test
  // surface keep working without callers having to change to the new flags.
  const legacyCliOpts: Record<string, unknown> = {
    lintEnforce: config.enforce,
    ...(config.lintConfigPath ? { lintConfig: config.lintConfigPath } : {}),
    ...(config.disableRules.length ? { lintDisableRule: config.disableRules } : {}),
    ...(config.middlewareCliOptions ?? {}),
  };

  const middlewares = buildMiddlewares({
    enabled,
    env: process.env,
    cliOpts: legacyCliOpts,
  });

  // Run prepare() up front so identity-resolution / config-load failures
  // surface at startup rather than on the first request.
  for (const mw of middlewares) {
    void mw.prepare?.();
  }

  // Duplicate-name detection is on by default; opt out with allowDuplicates.
  const duplicates = config.allowDuplicates
    ? null
    : new DuplicateChecker(upstream, config.duplicateTtlMs);

  const deps: HandlerDeps = { upstream, config, logger, duplicates, middlewares };

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (req) => handle(req, deps),
  });

  return {
    port: server.port ?? port,
    stop: async () => {
      await server.stop(true);
      await Promise.all(middlewares.map((m) => m.dispose?.()));
    },
  };
}

async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Internal endpoints — never forwarded. Allow GET and HEAD so load
  // balancers using HEAD probes don't accidentally hit the upstream.
  if (pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
    return new Response(req.method === "HEAD" ? null : "ok\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  const mutation = matchWorkflowMutation(req.method, pathname);
  if (mutation) {
    return handleWorkflowMutation(req, mutation, pathname, deps);
  }

  return handleTransparentForward(req, pathname, deps);
}

async function handleTransparentForward(
  req: Request,
  pathname: string,
  deps: HandlerDeps,
): Promise<Response> {
  try {
    const { response, elapsedMs } = await forwardRequest(req, deps.upstream, undefined, {
      timeoutMs: deps.config.upstreamTimeoutMs,
    });
    deps.logger.log({
      action: "forward",
      method: req.method,
      path: pathname,
      status: response.status,
      upstreamMs: elapsedMs,
    });
    return response;
  } catch (err) {
    return reportError(err, req, pathname, deps);
  }
}

async function handleWorkflowMutation(
  req: Request,
  mutation: WorkflowMutation,
  pathname: string,
  deps: HandlerDeps,
): Promise<Response> {
  const rawJSON = await req.text();
  const apiKey = req.headers.get("x-n8n-api-key");

  // Malformed JSON: return 400 from the proxy itself rather than layering on
  // an upstream 400. n8n would also reject it; one clear error beats two.
  let workflow: Workflow | null = null;
  try {
    workflow = JSON.parse(rawJSON) as Workflow;
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    deps.logger.log({
      action: "block",
      method: req.method,
      path: pathname,
      status: 400,
      message: `invalid JSON: ${message}`,
    });
    return buildBadJSONResponse(message);
  }

  // Middleware pipeline (lint + authz + future policies).
  // Identity is left undefined here so each middleware can resolve from
  // its own spec; the proxy doesn't need to know which middleware needs
  // identity or which header it lives on.
  const verdict = await runPipeline(deps.middlewares, {
    workflow,
    rawJSON,
    request: req,
    mode: "proxy",
  });

  const workflowName = workflow?.name;

  if (verdict.block) {
    deps.logger.log({
      action: "block",
      method: req.method,
      path: pathname,
      status: verdict.denial?.status ?? 422,
      workflowName,
      violations: verdict.violations.map((v) => ({
        rule: v.rule,
        severity: v.severity,
        message: v.message,
      })),
      message: verdict.blockedBy ? `blocked by middleware ${verdict.blockedBy}` : undefined,
    });
    return buildDenialResponse(verdict);
  }

  // Duplicate detection (creates only — updates target a specific id).
  let duplicateMatches: Awaited<ReturnType<DuplicateChecker["findByName"]>> = [];
  if (mutation.kind === "create" && deps.duplicates && workflow?.name) {
    try {
      duplicateMatches = await deps.duplicates.findByName(workflow.name, apiKey);
    } catch {
      // Treat lookup failure as "no duplicate" — see DuplicateChecker for rationale.
    }
    if (duplicateMatches.length > 0 && deps.config.enforce === "error") {
      deps.logger.log({
        action: "block",
        method: req.method,
        path: pathname,
        status: 409,
        workflowName,
        message: `duplicate name: ${duplicateMatches.length} match(es)`,
      });
      return buildDuplicateResponse(workflow.name, duplicateMatches);
    }
  }

  // Forward
  try {
    const { response, elapsedMs } = await forwardRequest(req, deps.upstream, rawJSON, {
      timeoutMs: deps.config.upstreamTimeoutMs,
    });
    if (verdict.violations.length > 0) {
      const errCount = verdict.violations.filter(
        (v) => v.severity === "error" || !v.severity,
      ).length;
      response.headers.set("x-n8n-lint-violations", String(verdict.violations.length));
      response.headers.set("x-n8n-lint-errors", String(errCount));
    }
    if (duplicateMatches.length > 0) {
      response.headers.set("x-n8n-duplicate-warning", String(duplicateMatches.length));
    }
    const action = verdict.violations.length > 0 || duplicateMatches.length > 0 ? "warn" : "pass";
    deps.logger.log({
      action,
      method: req.method,
      path: pathname,
      status: response.status,
      upstreamMs: elapsedMs,
      workflowName,
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
    });
    return response;
  } catch (err) {
    return reportError(err, req, pathname, deps);
  }
}

function reportError(err: unknown, req: Request, pathname: string, deps: HandlerDeps): Response {
  const message = err instanceof Error ? err.message : String(err);
  deps.logger.log({ action: "error", method: req.method, path: pathname, status: 502, message });
  return buildErrorResponse(message);
}
