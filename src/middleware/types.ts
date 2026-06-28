import type { Workflow } from "@/api/types.ts";
import type { Violation } from "@/lint/rules/violation.ts";

/** Where the pipeline is running. Middlewares can adapt to context. */
export type PipelineMode = "proxy" | "apply" | "single";

/** Per-request input handed to each middleware. */
export interface PreWriteContext {
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
 * Pre-write middleware contract. Implementations are constructed once per
 * pipeline (per-process for proxy, per-`apply` invocation otherwise) and
 * called for every workflow write.
 *
 * `prepare` runs once before the first workflow is evaluated. Long-running
 * resolvers (e.g. authz fetching the actor's groups) belong here so the
 * per-workflow path stays cheap.
 *
 * `dispose` is invoked on process shutdown / apply end. Used by middlewares
 * that hold long-lived state such as caches or background timers.
 */
export interface PreWriteMiddleware {
  readonly name: string;
  evaluate(ctx: PreWriteContext): Promise<MiddlewareVerdict> | MiddlewareVerdict;
  prepare?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

/**
 * Factory contract for registering a middleware with the CLI/env loader.
 *
 * Each builtin lives behind one of these so the registry can:
 *   1. Discover whether the user enabled it (via `--middleware` or env list).
 *   2. Collect options from env / CLI flags.
 *   3. Validate via zod and build the runtime middleware.
 *
 * Splitting build from collection keeps the loader testable in isolation —
 * unit tests assemble Options objects directly without going through env.
 */
export interface MiddlewareFactory<O> {
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
  build(options: unknown): PreWriteMiddleware;
}
