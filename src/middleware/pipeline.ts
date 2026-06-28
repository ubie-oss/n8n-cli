import type { Violation } from "@/lint/rules/violation.ts";
import type {
  MiddlewareVerdict,
  PipelineVerdict,
  PreWriteContext,
  PreWriteMiddleware,
} from "./types.ts";

/**
 * Runs every enabled middleware against `ctx` and aggregates the result.
 *
 * Semantics:
 * - The chain short-circuits at the first middleware that returns block=true.
 *   Subsequent middlewares do not run — they cannot un-block, and forcing
 *   downstream HTTP calls (authz, future policies) after a hard "no" would
 *   waste latency and side-effect quota.
 * - Violations from the blocking middleware are surfaced. Earlier
 *   non-blocking middlewares contribute their (warning-level) violations to
 *   the same list so callers see everything in one place.
 * - A middleware that throws is treated as block=true with a synthetic
 *   violation. This mirrors the defensive contract `src/proxy/enforcer.ts`
 *   already provides for lint and applies it uniformly to every policy —
 *   a malformed authz config never crashes the proxy.
 */
export async function runPipeline(
  chain: PreWriteMiddleware[],
  ctx: PreWriteContext,
): Promise<PipelineVerdict> {
  const violations: Violation[] = [];

  for (const mw of chain) {
    let verdict: MiddlewareVerdict;
    try {
      verdict = await mw.evaluate(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const synthetic: Violation = {
        rule: `${mw.name}-internal-error`,
        severity: "error",
        message: `Middleware "${mw.name}" threw: ${message}`,
      };
      return {
        block: true,
        blockedBy: mw.name,
        violations: [...violations, synthetic],
        denial: {
          status: 500,
          error: "middleware_internal_error",
          message: synthetic.message,
        },
      };
    }
    violations.push(...verdict.violations);
    if (verdict.block) {
      return {
        block: true,
        blockedBy: mw.name,
        violations,
        denial: verdict.denial,
      };
    }
  }

  return { block: false, violations };
}

/** Convenience: runs prepare() on every middleware that has one. */
export async function preparePipeline(chain: PreWriteMiddleware[]): Promise<void> {
  await Promise.all(chain.map((m) => m.prepare?.()));
}

/** Convenience: runs dispose() on every middleware that has one. */
export async function disposePipeline(chain: PreWriteMiddleware[]): Promise<void> {
  await Promise.all(chain.map((m) => m.dispose?.()));
}
