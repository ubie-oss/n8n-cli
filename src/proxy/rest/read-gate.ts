import { runPipeline } from "@/middleware/pipeline.ts";
import type {
  PipelineVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";

/**
 * Runs the body-less middleware chain against a request that names one
 * workflow (GET /workflows/:id, MCP tool calls).
 *
 * Same filter as tags / delete / activate: lint stays out because there is
 * no definition to judge. oauth-verify and impersonator-verify still run, so
 * they can populate `ctx.identity` before project-role reads it.
 *
 * Identity is left unset on `ctx` here — each middleware resolves or writes
 * it. That is the same contract the write path uses.
 */
export async function evaluateBodylessPipeline(
  middlewares: ServerMiddleware[],
  ctx: ServerMiddlewareContext,
): Promise<PipelineVerdict> {
  const applicable = middlewares.filter((m) => !m.readsWorkflowBody);
  if (applicable.length === 0) return { block: false, violations: [] };
  return runPipeline(applicable, ctx);
}
