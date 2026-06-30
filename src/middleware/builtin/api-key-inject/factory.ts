import { z } from "zod";
import type { ClientMiddlewareFactory } from "@/middleware/types.ts";
import { ApiKeyInjectMiddleware } from "./middleware.ts";

/**
 * Raw config shape parsed from env/CLI. `apiKey` is intentionally NOT
 * accepted directly on the CLI — secret values must come through an env
 * var so they don't end up in shell history, process listings, or
 * ps-style observability tooling.
 */
const optionsSchema = z.object({
  apiKey: z
    .string({ message: "api-key-inject: apiKey is required (set via N8N_API_KEY_INJECT_KEY env)" })
    .min(1, { message: "api-key-inject: apiKey must not be empty" }),
  header: z.string().default("X-N8N-API-KEY"),
  conflictPolicy: z.union([z.literal("replace"), z.literal("set-if-absent")]).default("replace"),
});

type ApiKeyInjectRawOptions = z.infer<typeof optionsSchema>;

function fromEnv(env: NodeJS.ProcessEnv): Partial<ApiKeyInjectRawOptions> {
  const out: Partial<ApiKeyInjectRawOptions> = {};
  // Direct key value via env. This is the canonical way to supply the key.
  if (env.N8N_API_KEY_INJECT_KEY) out.apiKey = env.N8N_API_KEY_INJECT_KEY;
  // Indirect: name of an env var that holds the key. Allows separating the
  // operator-chosen var name from this middleware's contract (e.g. when an
  // existing secret in the deployment env is named differently).
  if (!out.apiKey && env.N8N_API_KEY_INJECT_KEY_ENV_VAR) {
    const referenced = env[env.N8N_API_KEY_INJECT_KEY_ENV_VAR];
    if (referenced) out.apiKey = referenced;
  }
  if (env.N8N_API_KEY_INJECT_HEADER) out.header = env.N8N_API_KEY_INJECT_HEADER;
  if (env.N8N_API_KEY_INJECT_CONFLICT_POLICY) {
    out.conflictPolicy =
      env.N8N_API_KEY_INJECT_CONFLICT_POLICY as ApiKeyInjectRawOptions["conflictPolicy"];
  }
  return out;
}

function fromCLI(opts: Record<string, unknown>): Partial<ApiKeyInjectRawOptions> {
  const out: Partial<ApiKeyInjectRawOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  // CLI-level indirection only — `--api-key-inject-key-env-var <VAR>` resolves
  // the value from process.env at build time. The raw key never appears on
  // the CLI for the reasons described in the schema comment above.
  const envVarName = s("apiKeyInjectKeyEnvVar");
  if (envVarName) {
    const value = process.env[envVarName];
    if (value) out.apiKey = value;
  }
  if (s("apiKeyInjectHeader")) out.header = s("apiKeyInjectHeader");
  if (s("apiKeyInjectConflictPolicy")) {
    out.conflictPolicy = s(
      "apiKeyInjectConflictPolicy",
    ) as ApiKeyInjectRawOptions["conflictPolicy"];
  }
  return out;
}

export const apiKeyInjectFactory: ClientMiddlewareFactory<ApiKeyInjectRawOptions> = {
  name: "api-key-inject",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    return new ApiKeyInjectMiddleware(parsed);
  },
};

/** Exposed for unit tests that build options directly. */
export const apiKeyInjectOptionsSchema = optionsSchema;
