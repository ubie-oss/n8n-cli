import { z } from "zod";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { type LintEnforce, LintMiddleware, type LintMiddlewareOptions } from "./middleware.ts";

const enforceSchema: z.ZodType<LintEnforce> = z.union([
  z.literal("off"),
  z.literal("warn"),
  z.literal("error"),
]);

const optionsSchema = z.object({
  enforce: enforceSchema.default("error"),
  configPath: z.string().optional(),
  disableRules: z.array(z.string()).optional(),
  startDir: z.string().optional(),
});

/** Factory for the `lint` builtin middleware. */
export const lintFactory: ServerMiddlewareFactory<LintMiddlewareOptions> = {
  name: "lint",

  loadFromEnv(env) {
    const partial: Partial<LintMiddlewareOptions> = {};
    const enforce = env.N8N_LINT_ENFORCE;
    if (enforce) partial.enforce = enforce as LintEnforce;
    if (env.N8N_LINT_CONFIG) partial.configPath = env.N8N_LINT_CONFIG;
    if (env.N8N_LINT_DISABLE_RULES) {
      partial.disableRules = env.N8N_LINT_DISABLE_RULES.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    return partial;
  },

  loadFromCLI(opts) {
    const partial: Partial<LintMiddlewareOptions> = {};
    if (typeof opts.lintEnforce === "string") {
      partial.enforce = opts.lintEnforce as LintEnforce;
    }
    if (typeof opts.lintConfig === "string") {
      partial.configPath = opts.lintConfig;
    }
    if (typeof opts.lintDisableRule === "string") {
      partial.disableRules = (opts.lintDisableRule as string)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (Array.isArray(opts.lintDisableRule)) {
      partial.disableRules = (opts.lintDisableRule as unknown[]).map((s) => String(s).trim());
    }
    if (typeof opts.lintStartDir === "string") {
      partial.startDir = opts.lintStartDir;
    }
    return partial;
  },

  build(merged) {
    const parsed = optionsSchema.parse(merged);
    return new LintMiddleware(parsed);
  },
};
