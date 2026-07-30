import { z } from "zod";
import type { ServerMiddlewareFactory } from "@/middleware/types.ts";
import { AuthzMiddleware } from "./middleware.ts";
import type {
  AuthzEnforce,
  AuthzOnError,
  AuthzOptions,
  GroupsRequestSpec,
  WorkflowACLSpec,
} from "./types.ts";

const identitySchema = z.object({
  source: z.union([z.literal("header"), z.literal("env"), z.literal("none")]).default("none"),
  name: z.string().optional(),
  decode: z.union([z.literal("raw"), z.literal("jwt")]).default("raw"),
  claim: z.string().optional(),
});

// No defaults for `extract` paths: the response shape and the workflow
// metadata location are organization-specific. Forcing the user to declare
// them avoids silently assuming a particular tag convention or API schema.
// Same for `stripPrefix` — it's a string transform that depends on the
// organization's tag naming scheme.
const groupsAuthSchema = z.object({
  kind: z
    .union([z.literal("none"), z.literal("bearer-env"), z.literal("gcp-id-token")])
    .default("none"),
  tokenEnvVar: z.string().optional(),
  audience: z.string().optional(),
  tokenSource: z.union([z.literal("metadata"), z.literal("adc-impersonate")]).optional(),
  impersonateServiceAccount: z.string().optional(),
});

const groupsSchema = z.object({
  url: z.string({ message: "authz: groups.url is required" }).url(),
  /** Outgoing auth. Omitted means header-only, i.e. the previous behaviour. */
  auth: groupsAuthSchema.optional(),
  method: z.string().default("POST"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  extract: z
    .string({ message: "authz: groups.extract is required (JSONPath into the response)" })
    .min(1, { message: "authz: groups.extract must not be empty" }),
  cacheTtlMs: z.number().int().min(0).default(60_000),
  timeoutMs: z.number().int().min(0).default(5_000),
});

const workflowSchema = z.object({
  extract: z
    .string({ message: "authz: workflow.extract is required (JSONPath into the workflow)" })
    .min(1, { message: "authz: workflow.extract must not be empty" }),
  stripPrefix: z.string().optional(),
});

const enforceSchema: z.ZodType<AuthzEnforce> = z.union([
  z.literal("off"),
  z.literal("warn"),
  z.literal("error"),
]);

const onErrorSchema: z.ZodType<AuthzOnError> = z.union([z.literal("deny"), z.literal("allow")]);

const optionsSchema = z.object({
  enforce: enforceSchema.default("error"),
  onError: onErrorSchema.default("deny"),
  // Default identity to "none" so users that pass the per-request identity
  // on ServerMiddlewareContext directly (e.g. tests, custom callers) don't
  // have to declare extraction. Real proxy/apply runs always set this
  // explicitly.
  identity: identitySchema.default({ source: "none", decode: "raw" }),
  groups: groupsSchema,
  workflow: workflowSchema,
  // Default "request" keeps existing deployments behaving as before; "upstream"
  // is what makes the ACL non-forgeable (and what an ACL kept in tags needs).
  aclSource: z.union([z.literal("request"), z.literal("upstream")]).default("request"),
  aclCacheTtlMs: z.number().int().min(0).default(10_000),
  onMissingAcl: z.union([z.literal("deny"), z.literal("allow")]).default("deny"),
  bootstrapGroups: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
});

/** Comma-separated list → trimmed, non-empty entries. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pulls Authz config off the env. Splits the config into namespaced bags
 * so `loadFromCLI` can override individual fields without re-assembling
 * the whole structure.
 */
function fromEnv(env: NodeJS.ProcessEnv): Partial<AuthzOptions> {
  const opts: Partial<AuthzOptions> = {};
  if (env.N8N_AUTHZ_ENFORCE) opts.enforce = env.N8N_AUTHZ_ENFORCE as AuthzEnforce;
  if (env.N8N_AUTHZ_ON_ERROR) opts.onError = env.N8N_AUTHZ_ON_ERROR as AuthzOnError;

  const identity = {
    source: env.N8N_AUTHZ_IDENTITY_SOURCE as "header" | "env" | "none" | undefined,
    name:
      env.N8N_AUTHZ_IDENTITY_NAME ?? env.N8N_AUTHZ_IDENTITY_HEADER ?? env.N8N_AUTHZ_IDENTITY_ENV,
    decode: env.N8N_AUTHZ_IDENTITY_DECODE as "raw" | "jwt" | undefined,
    claim: env.N8N_AUTHZ_IDENTITY_CLAIM,
  };
  if (Object.values(identity).some((v) => v !== undefined)) {
    opts.identity = identity as AuthzOptions["identity"];
  }

  const groups: Partial<GroupsRequestSpec> = {};
  if (env.N8N_AUTHZ_GROUPS_URL) groups.url = env.N8N_AUTHZ_GROUPS_URL;
  if (env.N8N_AUTHZ_GROUPS_METHOD) groups.method = env.N8N_AUTHZ_GROUPS_METHOD;
  if (env.N8N_AUTHZ_GROUPS_HEADERS) {
    try {
      groups.headers = JSON.parse(env.N8N_AUTHZ_GROUPS_HEADERS) as Record<string, string>;
    } catch {
      // Malformed JSON in env. Let zod surface the error downstream rather
      // than swallowing here — users get one clear error at build time.
    }
  }
  const groupsAuth: Record<string, string> = {};
  if (env.N8N_AUTHZ_GROUPS_AUTH_KIND) groupsAuth.kind = env.N8N_AUTHZ_GROUPS_AUTH_KIND;
  if (env.N8N_AUTHZ_GROUPS_AUTH_TOKEN_ENV_VAR)
    groupsAuth.tokenEnvVar = env.N8N_AUTHZ_GROUPS_AUTH_TOKEN_ENV_VAR;
  if (env.N8N_AUTHZ_GROUPS_AUTH_AUDIENCE) groupsAuth.audience = env.N8N_AUTHZ_GROUPS_AUTH_AUDIENCE;
  if (env.N8N_AUTHZ_GROUPS_AUTH_TOKEN_SOURCE)
    groupsAuth.tokenSource = env.N8N_AUTHZ_GROUPS_AUTH_TOKEN_SOURCE;
  if (env.N8N_AUTHZ_GROUPS_AUTH_IMPERSONATE_SERVICE_ACCOUNT)
    groupsAuth.impersonateServiceAccount = env.N8N_AUTHZ_GROUPS_AUTH_IMPERSONATE_SERVICE_ACCOUNT;
  if (Object.keys(groupsAuth).length > 0) {
    groups.auth = groupsAuth as unknown as GroupsRequestSpec["auth"];
  }
  if (env.N8N_AUTHZ_GROUPS_BODY) groups.body = env.N8N_AUTHZ_GROUPS_BODY;
  if (env.N8N_AUTHZ_GROUPS_EXTRACT) groups.extract = env.N8N_AUTHZ_GROUPS_EXTRACT;
  if (env.N8N_AUTHZ_GROUPS_CACHE_TTL_MS)
    groups.cacheTtlMs = Number.parseInt(env.N8N_AUTHZ_GROUPS_CACHE_TTL_MS, 10);
  if (env.N8N_AUTHZ_GROUPS_TIMEOUT_MS)
    groups.timeoutMs = Number.parseInt(env.N8N_AUTHZ_GROUPS_TIMEOUT_MS, 10);
  if (Object.keys(groups).length > 0) opts.groups = groups as GroupsRequestSpec;

  if (env.N8N_AUTHZ_ACL_SOURCE) {
    opts.aclSource = env.N8N_AUTHZ_ACL_SOURCE as AuthzOptions["aclSource"];
  }
  if (env.N8N_AUTHZ_ACL_CACHE_TTL_MS) {
    opts.aclCacheTtlMs = Number.parseInt(env.N8N_AUTHZ_ACL_CACHE_TTL_MS, 10);
  }
  if (env.N8N_AUTHZ_ON_MISSING_ACL) {
    opts.onMissingAcl = env.N8N_AUTHZ_ON_MISSING_ACL as AuthzOptions["onMissingAcl"];
  }
  if (env.N8N_AUTHZ_BOOTSTRAP_GROUPS)
    opts.bootstrapGroups = splitList(env.N8N_AUTHZ_BOOTSTRAP_GROUPS);
  if (env.N8N_AUTHZ_ACTIONS) opts.actions = splitList(env.N8N_AUTHZ_ACTIONS);

  const workflow: Partial<WorkflowACLSpec> = {};
  if (env.N8N_AUTHZ_WORKFLOW_EXTRACT) workflow.extract = env.N8N_AUTHZ_WORKFLOW_EXTRACT;
  if (env.N8N_AUTHZ_WORKFLOW_STRIP_PREFIX !== undefined)
    workflow.stripPrefix = env.N8N_AUTHZ_WORKFLOW_STRIP_PREFIX;
  if (Object.keys(workflow).length > 0) opts.workflow = workflow as WorkflowACLSpec;

  return opts;
}

function fromCLI(opts: Record<string, unknown>): Partial<AuthzOptions> {
  const out: Partial<AuthzOptions> = {};
  const s = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  const n = (k: string) => {
    const v = opts[k];
    if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10);
    if (typeof v === "number") return v;
    return undefined;
  };

  if (s("authzEnforce")) out.enforce = s("authzEnforce") as AuthzEnforce;
  if (s("authzOnError")) out.onError = s("authzOnError") as AuthzOnError;

  const identity = {
    source: s("authzIdentitySource") as "header" | "env" | "none" | undefined,
    name: s("authzIdentityName") ?? s("authzIdentityHeader") ?? s("authzIdentityEnv"),
    decode: s("authzIdentityDecode") as "raw" | "jwt" | undefined,
    claim: s("authzIdentityClaim"),
  };
  if (Object.values(identity).some((v) => v !== undefined)) {
    out.identity = identity as AuthzOptions["identity"];
  }

  const groups: Partial<GroupsRequestSpec> = {};
  if (s("authzGroupsUrl")) groups.url = s("authzGroupsUrl");
  if (s("authzGroupsMethod")) groups.method = s("authzGroupsMethod");
  if (s("authzGroupsHeaders")) {
    try {
      groups.headers = JSON.parse(s("authzGroupsHeaders")!) as Record<string, string>;
    } catch {
      // see note in fromEnv
    }
  }
  if (s("authzGroupsBody")) groups.body = s("authzGroupsBody");
  if (s("authzGroupsExtract")) groups.extract = s("authzGroupsExtract");
  const ttl = n("authzGroupsCacheTtlMs");
  if (ttl !== undefined) groups.cacheTtlMs = ttl;
  const timeout = n("authzGroupsTimeoutMs");
  if (timeout !== undefined) groups.timeoutMs = timeout;
  if (Object.keys(groups).length > 0) out.groups = groups as GroupsRequestSpec;

  const workflow: Partial<WorkflowACLSpec> = {};
  if (s("authzWorkflowExtract")) workflow.extract = s("authzWorkflowExtract");
  if (
    opts.authzWorkflowStripPrefix !== undefined &&
    typeof opts.authzWorkflowStripPrefix === "string"
  ) {
    workflow.stripPrefix = opts.authzWorkflowStripPrefix as string;
  }
  if (Object.keys(workflow).length > 0) out.workflow = workflow as WorkflowACLSpec;

  if (s("authzAclSource")) out.aclSource = s("authzAclSource") as AuthzOptions["aclSource"];
  const aclTtl = n("authzAclCacheTtlMs");
  if (aclTtl !== undefined) out.aclCacheTtlMs = aclTtl;
  if (s("authzOnMissingAcl")) {
    out.onMissingAcl = s("authzOnMissingAcl") as AuthzOptions["onMissingAcl"];
  }
  if (s("authzBootstrapGroups"))
    out.bootstrapGroups = splitList(s("authzBootstrapGroups") as string);
  if (s("authzActions")) out.actions = splitList(s("authzActions") as string);

  return out;
}

export const authzFactory: ServerMiddlewareFactory<AuthzOptions> = {
  name: "authz",
  loadFromEnv: fromEnv,
  loadFromCLI: fromCLI,
  build(merged) {
    const parsed = optionsSchema.parse(merged) as AuthzOptions;
    return new AuthzMiddleware(parsed);
  },
};

/** Exposed for unit tests that build options directly. */
export const authzOptionsSchema = optionsSchema;
