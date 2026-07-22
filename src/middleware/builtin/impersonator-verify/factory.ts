import { z } from "zod";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { ImpersonatorVerifyMiddleware } from "./middleware.ts";
import type {
  ImpersonatorRequirement,
  ImpersonatorVerifyEnforce,
  ImpersonatorVerifyOptions,
} from "./types.ts";

const enforceSchema: z.ZodType<ImpersonatorVerifyEnforce> = z.union([
  z.literal("off"),
  z.literal("warn"),
  z.literal("deny"),
]);

const requirementSchema: z.ZodType<ImpersonatorRequirement> = z.union([
  z.literal("require"),
  z.literal("optional"),
]);

const optionsSchema = z.object({
  enforce: enforceSchema.default("deny"),
  requirement: requirementSchema.default("optional"),
  expectedAudiences: z.array(z.string().min(1)).default([]),
});

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<ImpersonatorVerifyOptions> {
  const out: Partial<ImpersonatorVerifyOptions> = {};
  if (env.N8N_IMPERSONATOR_VERIFY_ENFORCE) {
    out.enforce = env.N8N_IMPERSONATOR_VERIFY_ENFORCE as ImpersonatorVerifyEnforce;
  }
  if (env.N8N_IMPERSONATOR_VERIFY_REQUIREMENT) {
    out.requirement = env.N8N_IMPERSONATOR_VERIFY_REQUIREMENT as ImpersonatorRequirement;
  }
  const aud = splitList(env.N8N_IMPERSONATOR_VERIFY_EXPECTED_AUDIENCES);
  if (aud) out.expectedAudiences = aud;
  return out;
}

function fromCLI(opts: Record<string, unknown>): Partial<ImpersonatorVerifyOptions> {
  const out: Partial<ImpersonatorVerifyOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const list = (k: string) => splitList(s(k));

  if (s("impersonatorVerifyEnforce")) {
    out.enforce = s("impersonatorVerifyEnforce") as ImpersonatorVerifyEnforce;
  }
  if (s("impersonatorVerifyRequirement")) {
    out.requirement = s("impersonatorVerifyRequirement") as ImpersonatorRequirement;
  }
  const aud = list("impersonatorVerifyExpectedAudiences");
  if (aud) out.expectedAudiences = aud;
  return out;
}

export const impersonatorVerifyFactory: ServerMiddlewareFactory<ImpersonatorVerifyOptions> = {
  name: "impersonator-verify",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged) as ImpersonatorVerifyOptions;
    return new ImpersonatorVerifyMiddleware(parsed);
  },
};

export const impersonatorVerifyOptionsSchema = optionsSchema;
