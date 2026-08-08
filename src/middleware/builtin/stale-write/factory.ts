import { z } from "zod";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { StaleWriteMiddleware } from "./middleware.ts";
import type {
  StaleWriteEnforce,
  StaleWriteOnError,
  StaleWriteOnMissingBase,
  StaleWriteOptions,
} from "./types.ts";

const optionsSchema = z.object({
  // Unlike lint, this check needs cooperation from the client — a caller that
  // sends no base revision cannot be judged. Defaulting to `error` would turn
  // the guard on the moment someone adds "stale-write" to their chain, before
  // they have decided what to do about writers that do not send one. Operators
  // opt in explicitly.
  enforce: z.union([z.literal("off"), z.literal("warn"), z.literal("error")]).default("off"),
  onMissingBase: z.union([z.literal("allow"), z.literal("deny")]).default("allow"),
  onError: z.union([z.literal("allow"), z.literal("deny")]).default("deny"),
  actions: z.array(z.string()).default(["update"]),
});

/** Comma-separated list → trimmed, non-empty entries. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<StaleWriteOptions> {
  const opts: Partial<StaleWriteOptions> = {};
  if (env.N8N_STALE_WRITE_ENFORCE) {
    opts.enforce = env.N8N_STALE_WRITE_ENFORCE as StaleWriteEnforce;
  }
  if (env.N8N_STALE_WRITE_ON_MISSING_BASE) {
    opts.onMissingBase = env.N8N_STALE_WRITE_ON_MISSING_BASE as StaleWriteOnMissingBase;
  }
  if (env.N8N_STALE_WRITE_ON_ERROR) {
    opts.onError = env.N8N_STALE_WRITE_ON_ERROR as StaleWriteOnError;
  }
  if (env.N8N_STALE_WRITE_ACTIONS) {
    opts.actions = splitList(env.N8N_STALE_WRITE_ACTIONS);
  }
  return opts;
}

function fromCLI(cliOpts: Record<string, unknown>): Partial<StaleWriteOptions> {
  const out: Partial<StaleWriteOptions> = {};
  const s = (k: string) => (typeof cliOpts[k] === "string" ? (cliOpts[k] as string) : undefined);

  const enforce = s("staleWriteEnforce");
  if (enforce) out.enforce = enforce as StaleWriteEnforce;
  const onMissingBase = s("staleWriteOnMissingBase");
  if (onMissingBase) out.onMissingBase = onMissingBase as StaleWriteOnMissingBase;
  const onError = s("staleWriteOnError");
  if (onError) out.onError = onError as StaleWriteOnError;
  const actions = s("staleWriteActions");
  if (actions) out.actions = splitList(actions);

  return out;
}

export const staleWriteFactory: ServerMiddlewareFactory<StaleWriteOptions> = {
  name: "stale-write",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged) as StaleWriteOptions;
    return new StaleWriteMiddleware(parsed);
  },
};

/** Exposed for unit tests that build options directly. */
export const staleWriteOptionsSchema = optionsSchema;
