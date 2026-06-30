import type { Workflow } from "@/api/types.ts";
import type { Violation } from "@/lint/rules/violation.ts";

/** Where the pipeline is running. Middlewares can adapt to context. */
export type PipelineMode = "proxy" | "apply" | "single";

/** Per-request input handed to each server middleware. */
export interface ServerMiddlewareContext {
  /** Parsed workflow. May be null when JSON parsing failed upstream. */
  workflow: Workflow | null;
  /**
   * Raw JSON body. Pass undefined when the workflow was assembled in-memory
   * (e.g. apply reading a file, or `workflow update --file`). Middlewares that
   * need line numbers fall back to JSON.stringify(workflow).
   */
  rawJSON?: string;
  /** Incoming HTTP request (proxy mode only). */
  request?: Request;
  /** Identifier of the actor performing the write, if resolvable. */
  identity?: string;
  /** Which call site is running the pipeline. */
  mode: PipelineMode;
}

/**
 * Hint to the proxy about how a denial should be surfaced to the client.
 *
 * `status` and `error` mirror the existing buildLintErrorResponse shape so
 * callers receive the same JSON payload regardless of which middleware
 * blocked the request.
 */
export interface DenialResponseHint {
  status: number;
  /** Machine-readable code, e.g. "workflow_lint_failed" / "workflow_authz_denied". */
  error: string;
  message: string;
}

/** Verdict returned by a single middleware. */
export interface MiddlewareVerdict {
  block: boolean;
  violations: Violation[];
  denial?: DenialResponseHint;
}

/** Aggregate verdict produced by runPipeline. */
export interface PipelineVerdict {
  block: boolean;
  violations: Violation[];
  /** First middleware that returned block=true, if any. */
  blockedBy?: string;
  /** Denial hint contributed by the first blocking middleware. */
  denial?: DenialResponseHint;
}

/**
 * Server-side middleware contract. Runs on the ingress (proxy receive /
 * apply read) side, where the responsibility is "should this write proceed
 * at all?". Implementations are constructed once per pipeline (per-process
 * for proxy, per-`apply` invocation otherwise) and called for every workflow
 * write.
 *
 * `prepare` runs once before the first workflow is evaluated. Long-running
 * resolvers (e.g. authz fetching the actor's groups) belong here so the
 * per-workflow path stays cheap.
 *
 * `dispose` is invoked on process shutdown / apply end. Used by middlewares
 * that hold long-lived state such as caches or background timers.
 *
 * Mirrors gRPC's ServerInterceptor concept. The egress counterpart that
 * rewrites the outgoing upstream request lives in `ClientMiddleware`.
 */
export interface ServerMiddleware {
  readonly name: string;
  evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> | MiddlewareVerdict;
  prepare?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

/**
 * Factory contract for registering a server middleware with the CLI/env
 * loader.
 *
 * Each builtin lives behind one of these so the registry can:
 *   1. Discover whether the user enabled it (via `--server-middleware` or env list).
 *   2. Collect options from env / CLI flags.
 *   3. Validate via zod and build the runtime middleware.
 *
 * Splitting build from collection keeps the loader testable in isolation —
 * unit tests assemble Options objects directly without going through env.
 */
export interface ServerMiddlewareFactory<O> {
  readonly name: string;
  /**
   * Returns a partial Options block parsed from process.env. Returning a
   * partial object (rather than a full Options) lets the CLI override env.
   */
  loadFromEnv(env: NodeJS.ProcessEnv): Partial<O>;
  /**
   * Returns a partial Options block parsed from commander-shaped options.
   * Implementations should accept the flat object commander hands to
   * `.action()`.
   */
  loadFromCLI(cliOpts: Record<string, unknown>): Partial<O>;
  /**
   * Validates the merged options block and constructs the middleware.
   * Throws when required fields are missing or malformed; callers surface
   * the error message verbatim.
   */
  build(options: unknown): ServerMiddleware;
}

/**
 * Context handed to a `ClientMiddleware.apply()` call right before the
 * proxy fetches the upstream. Mirrors what the proxy actually has on hand —
 * the original incoming request (for headers/identity), the resolved
 * upstream URL, the HTTP method, and the path being forwarded.
 *
 * Client middlewares mutate `headers` in place; the proxy then uses that
 * (already hop-by-hop stripped) Headers instance for the upstream fetch.
 */
export interface ClientMiddlewareContext {
  /** The original incoming Request from the proxy client. */
  request: Request;
  /** HTTP method that will be sent upstream. */
  method: string;
  /** Pathname (and query) of the upstream URL — useful for scope decisions. */
  pathname: string;
  /** Fully-resolved upstream URL the proxy is about to fetch. */
  upstreamUrl: string;
}

/**
 * Client-side middleware contract. Runs on the egress side, right before the
 * proxy forwards a request to upstream. Used to rewrite outgoing headers —
 * e.g. mint an IAP id_token, inject a shared n8n API key, propagate a trace
 * header.
 *
 * Runs for EVERY upstream call the proxy makes (workflow mutations and
 * transparent forwards alike) — distinct from `ServerMiddleware`, which only
 * runs for the policy-gated workflow-mutation path.
 *
 * Mirrors gRPC's ClientInterceptor concept.
 */
export interface ClientMiddleware {
  readonly name: string;
  /**
   * Mutate `headers` in place. The proxy has already stripped hop-by-hop
   * headers, so callers can freely add/remove without re-checking that
   * surface.
   *
   * Throwing here aborts the upstream fetch — the proxy will return 502 to
   * the client with the error message. Use this for unrecoverable errors
   * (e.g. failed id_token mint); for soft degradation, swallow and continue.
   */
  apply(headers: Headers, ctx: ClientMiddlewareContext): Promise<void> | void;
  prepare?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

/**
 * Factory contract for registering a client middleware with the CLI/env
 * loader. Same shape as `ServerMiddlewareFactory`; kept as a separate type
 * so the registry can stay statically split between the two pipelines.
 */
export interface ClientMiddlewareFactory<O> {
  readonly name: string;
  loadFromEnv(env: NodeJS.ProcessEnv): Partial<O>;
  loadFromCLI(cliOpts: Record<string, unknown>): Partial<O>;
  build(options: unknown): ClientMiddleware;
}
