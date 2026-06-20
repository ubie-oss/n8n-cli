import type { Workflow } from "@/api/types.ts";
import { type LintConfig, loadLintConfig } from "@/lint/config.ts";
import type { RuleWithConfig } from "@/lint/registry.ts";
import { registerDefaultRules } from "@/lint/rules/index.ts";
import { normalizeUpstream, type ProxyConfig, parseListenAddr } from "./config.ts";
import { evaluate } from "./enforcer.ts";
import { Logger } from "./logging.ts";
import { buildErrorResponse, buildLintErrorResponse } from "./response.ts";
import { matchWorkflowMutation } from "./rest/router.ts";
import { forwardRequest } from "./upstream.ts";

export interface ProxyHandle {
  port: number;
  stop: () => Promise<void>;
}

/** Starts the proxy server. Returns a handle so tests can stop it cleanly. */
export function startProxy(config: ProxyConfig): ProxyHandle {
  const { host, port } = parseListenAddr(config.listen);
  const upstream = normalizeUpstream(config.upstream);
  const logger = new Logger(config.logFormat);

  const registry = registerDefaultRules();
  const lintConfig: LintConfig = loadLintConfig(config.lintConfigPath);
  const enabledRules: RuleWithConfig[] = registry.enabledRulesWithConfig(
    lintConfig,
    config.disableRules,
  );

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (req) => handle(req, upstream, enabledRules, lintConfig, config, logger),
  });

  return {
    port: server.port ?? port,
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function handle(
  req: Request,
  upstream: string,
  rules: RuleWithConfig[],
  lintConfig: LintConfig,
  config: ProxyConfig,
  logger: Logger,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Internal health endpoint — never forwarded.
  if (pathname === "/healthz" && req.method === "GET") {
    return new Response("ok\n", { status: 200, headers: { "content-type": "text/plain" } });
  }

  const mutation = matchWorkflowMutation(req.method, pathname);

  if (mutation) {
    return handleWorkflowMutation(req, upstream, rules, lintConfig, config, logger, pathname);
  }

  // Transparent forward.
  try {
    const { response, elapsedMs } = await forwardRequest(req, upstream);
    logger.log({
      action: "forward",
      method: req.method,
      path: pathname,
      status: response.status,
      upstreamMs: elapsedMs,
    });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log({ action: "error", method: req.method, path: pathname, status: 502, message });
    return buildErrorResponse(message);
  }
}

async function handleWorkflowMutation(
  req: Request,
  upstream: string,
  rules: RuleWithConfig[],
  lintConfig: LintConfig,
  config: ProxyConfig,
  logger: Logger,
  pathname: string,
): Promise<Response> {
  const rawJSON = await req.text();
  let workflow: Workflow | null = null;
  try {
    workflow = JSON.parse(rawJSON) as Workflow;
  } catch {
    // Leave null; json-syntax rule will flag it. The upstream would also reject
    // malformed JSON, so we still forward when enforcement is off/warn.
  }

  const verdict = evaluate(workflow, rawJSON, rules, lintConfig, config.enforce);
  const workflowName = workflow?.name;

  if (verdict.block) {
    logger.log({
      action: "block",
      method: req.method,
      path: pathname,
      status: 422,
      workflowName,
      violations: verdict.violations.map((v) => ({
        rule: v.rule,
        severity: v.severity,
        message: v.message,
      })),
    });
    return buildLintErrorResponse(verdict.violations);
  }

  try {
    const { response, elapsedMs } = await forwardRequest(req, upstream, rawJSON);
    const action = verdict.violations.length > 0 ? "warn" : "pass";
    const status = response.status;
    if (verdict.violations.length > 0) {
      const errCount = verdict.violations.filter(
        (v) => v.severity === "error" || !v.severity,
      ).length;
      response.headers.set("x-n8n-lint-violations", String(verdict.violations.length));
      response.headers.set("x-n8n-lint-errors", String(errCount));
    }
    logger.log({
      action,
      method: req.method,
      path: pathname,
      status,
      upstreamMs: elapsedMs,
      workflowName,
      violations: verdict.violations.length
        ? verdict.violations.map((v) => ({
            rule: v.rule,
            severity: v.severity,
            message: v.message,
          }))
        : undefined,
    });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log({ action: "error", method: req.method, path: pathname, status: 502, message });
    return buildErrorResponse(message);
  }
}
