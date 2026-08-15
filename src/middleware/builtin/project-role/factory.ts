import { z } from "zod";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { ProjectRoleMiddleware } from "./middleware.ts";
import type {
  ProjectRoleEnforce,
  ProjectRoleOnError,
  ProjectRoleOnMissingProject,
  ProjectRoleOptions,
} from "./types.ts";

const identitySchema = z.object({
  source: z.union([z.literal("header"), z.literal("env"), z.literal("none")]).default("none"),
  name: z.string().optional(),
  decode: z.union([z.literal("raw"), z.literal("jwt")]).default("raw"),
  claim: z.string().optional(),
});

const optionsSchema = z.object({
  enforce: z.union([z.literal("off"), z.literal("warn"), z.literal("error")]).default("off"),
  onError: z.union([z.literal("deny"), z.literal("allow")]).default("deny"),
  onMissingProject: z.union([z.literal("deny"), z.literal("allow")]).default("allow"),
  identity: identitySchema.default({ source: "none", decode: "raw" }),
  membersCacheTtlMs: z.number().int().min(0).default(60_000),
  instanceRoleCacheTtlMs: z.number().int().min(0).default(60_000),
  timeoutMs: z.number().int().min(0).default(10_000),
  actions: z.array(z.string()).default([]),
  upstream: z.string().url({ message: "project-role: upstream URL is required" }),
});

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fromEnv(env: NodeJS.ProcessEnv): Partial<ProjectRoleOptions & { upstream?: string }> {
  const opts: Partial<ProjectRoleOptions & { upstream?: string }> = {};
  if (env.N8N_PROJECT_ROLE_ENFORCE) {
    opts.enforce = env.N8N_PROJECT_ROLE_ENFORCE as ProjectRoleEnforce;
  }
  if (env.N8N_PROJECT_ROLE_ON_ERROR) {
    opts.onError = env.N8N_PROJECT_ROLE_ON_ERROR as ProjectRoleOnError;
  }
  if (env.N8N_PROJECT_ROLE_ON_MISSING_PROJECT) {
    opts.onMissingProject = env.N8N_PROJECT_ROLE_ON_MISSING_PROJECT as ProjectRoleOnMissingProject;
  }
  if (env.N8N_PROJECT_ROLE_MEMBERS_CACHE_TTL_MS) {
    opts.membersCacheTtlMs = Number.parseInt(env.N8N_PROJECT_ROLE_MEMBERS_CACHE_TTL_MS, 10);
  }
  if (env.N8N_PROJECT_ROLE_INSTANCE_ROLE_CACHE_TTL_MS) {
    opts.instanceRoleCacheTtlMs = Number.parseInt(
      env.N8N_PROJECT_ROLE_INSTANCE_ROLE_CACHE_TTL_MS,
      10,
    );
  }
  if (env.N8N_PROJECT_ROLE_TIMEOUT_MS) {
    opts.timeoutMs = Number.parseInt(env.N8N_PROJECT_ROLE_TIMEOUT_MS, 10);
  }
  if (env.N8N_PROJECT_ROLE_ACTIONS) {
    opts.actions = splitList(env.N8N_PROJECT_ROLE_ACTIONS);
  }
  if (env.N8N_PROJECT_ROLE_UPSTREAM) {
    opts.upstream = env.N8N_PROJECT_ROLE_UPSTREAM;
  }

  const identity = {
    source: env.N8N_PROJECT_ROLE_IDENTITY_SOURCE as "header" | "env" | "none" | undefined,
    name: env.N8N_PROJECT_ROLE_IDENTITY_NAME,
    decode: env.N8N_PROJECT_ROLE_IDENTITY_DECODE as "raw" | "jwt" | undefined,
    claim: env.N8N_PROJECT_ROLE_IDENTITY_CLAIM,
  };
  if (Object.values(identity).some((v) => v !== undefined)) {
    opts.identity = identity as ProjectRoleOptions["identity"];
  }
  return opts;
}

function fromCLI(
  cliOpts: Record<string, unknown>,
): Partial<ProjectRoleOptions & { upstream?: string }> {
  const out: Partial<ProjectRoleOptions & { upstream?: string }> = {};
  const s = (k: string) => (typeof cliOpts[k] === "string" ? (cliOpts[k] as string) : undefined);
  const n = (k: string) => {
    const v = cliOpts[k];
    if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
    if (typeof v === "number") return v;
    return undefined;
  };

  if (s("projectRoleEnforce")) out.enforce = s("projectRoleEnforce") as ProjectRoleEnforce;
  if (s("projectRoleOnError")) out.onError = s("projectRoleOnError") as ProjectRoleOnError;
  if (s("projectRoleOnMissingProject")) {
    out.onMissingProject = s("projectRoleOnMissingProject") as ProjectRoleOnMissingProject;
  }
  const membersTtl = n("projectRoleMembersCacheTtlMs");
  if (membersTtl !== undefined) out.membersCacheTtlMs = membersTtl;
  const instanceTtl = n("projectRoleInstanceRoleCacheTtlMs");
  if (instanceTtl !== undefined) out.instanceRoleCacheTtlMs = instanceTtl;
  const timeout = n("projectRoleTimeoutMs");
  if (timeout !== undefined) out.timeoutMs = timeout;
  if (s("projectRoleActions")) out.actions = splitList(s("projectRoleActions") as string);
  if (typeof cliOpts.projectRoleUpstream === "string") {
    out.upstream = cliOpts.projectRoleUpstream;
  }
  if (Array.isArray(cliOpts.clientMiddlewares)) {
    (out as { clientMiddlewares?: unknown }).clientMiddlewares = cliOpts.clientMiddlewares;
  }

  const identity = {
    source: s("projectRoleIdentitySource") as "header" | "env" | "none" | undefined,
    name: s("projectRoleIdentityName"),
    decode: s("projectRoleIdentityDecode") as "raw" | "jwt" | undefined,
    claim: s("projectRoleIdentityClaim"),
  };
  if (Object.values(identity).some((v) => v !== undefined)) {
    out.identity = identity as ProjectRoleOptions["identity"];
  }
  return out;
}

export const projectRoleFactory: ServerMiddlewareFactory<
  ProjectRoleOptions & { upstream: string }
> = {
  name: "project-role",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged);
    const { upstream, ...options } = parsed;
    const clientMiddlewares = (
      merged as { clientMiddlewares?: import("@/middleware/types.ts").ClientMiddleware[] }
    ).clientMiddlewares;
    return new ProjectRoleMiddleware(options as ProjectRoleOptions, {
      upstream,
      clientMiddlewares,
      timeoutMs: options.timeoutMs,
    });
  },
};

export const projectRoleOptionsSchema = optionsSchema;
