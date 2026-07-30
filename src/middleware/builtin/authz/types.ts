import type { IdentitySpec } from "@/middleware/identity.ts";

/**
 * How to authenticate the outgoing groups request.
 *
 * A groups API worth trusting is rarely open: it sits behind an identity-aware
 * proxy, or wants a bearer token. Static headers cannot express that when the
 * credential is a short-lived id_token, so the source is pluggable. `none`
 * keeps the header-only behaviour.
 */
export interface GroupsAuthSpec {
  kind: "none" | "bearer-env" | "gcp-id-token";
  /** bearer-env: env var holding the token. */
  tokenEnvVar?: string;
  /** gcp-id-token: `aud` of the minted token. */
  audience?: string;
  /** gcp-id-token: where the token comes from. */
  tokenSource?: "metadata" | "adc-impersonate";
  /** gcp-id-token: service account to mint as (required by adc-impersonate). */
  impersonateServiceAccount?: string;
}

/**
 * Configuration for fetching the actor's group memberships from an HTTP
 * service. Every field is user-supplied so the middleware has no built-in
 * knowledge of any specific groups API.
 */
export interface GroupsRequestSpec {
  url: string;
  method: string;
  /** Outgoing authentication. Defaults to `{ kind: "none" }`. */
  auth?: GroupsAuthSpec;
  /**
   * Header map. Values support `${env:VAR}` for secret injection.
   */
  headers: Record<string, string>;
  /**
   * Optional request body. Supports `${env:VAR}` and `${json:identity}`.
   * Sent as-is — the caller is responsible for matching the upstream's
   * content-type.
   */
  body?: string;
  /** JSONPath into the response body. Matches → array of group identifiers. */
  extract: string;
  /** Per-process cache TTL for the identity → groups mapping. */
  cacheTtlMs: number;
  /** Per-request HTTP timeout. */
  timeoutMs: number;
}

/**
 * How to read the list of allowed groups off the workflow object.
 *
 * Both fields are user-supplied — there is no built-in assumption about
 * where ACL information lives or how it is encoded. Users declare the
 * JSONPath that selects the ACL strings and (optionally) a prefix to
 * strip so the matched values become bare group identifiers.
 *
 * Example: if a workflow tags ACL entries as `mygroup:eng`, the user
 * passes `extract = "$.tags[*].name"` and `stripPrefix = "mygroup:"`.
 */
export interface WorkflowACLSpec {
  /** JSONPath into the parsed workflow. Matches → array of strings. */
  extract: string;
  /**
   * Optional prefix to strip from each match. When set, matches that do
   * NOT start with the prefix are dropped (so ACL tags can coexist with
   * unrelated tags). Omit or set empty to use matches verbatim.
   */
  stripPrefix?: string;
}

export type AuthzEnforce = "off" | "warn" | "error";

/**
 * What to do when the groups API call fails (network error, non-2xx,
 * unparseable body). `deny` is the safer default — it matches the user
 * goal of "guardrail against AI agents", where the failure mode of a
 * runaway agent making changes during a backend outage is worse than the
 * failure mode of denying writes during the outage.
 */
export type AuthzOnError = "deny" | "allow";

/**
 * Where the ACL is read from.
 *
 * `upstream` is the meaningful setting: it reads the *stored* workflow, so a
 * caller cannot grant themselves access by putting their own group in the body
 * of the very request being authorized. It is also the only workable setting
 * for an ACL kept in n8n tags — tags are assigned through a separate endpoint,
 * so they are simply absent from a workflow write payload.
 *
 * `request` keeps the original behaviour for deployments whose ACL genuinely
 * travels in the body and who only want a guardrail against accidents.
 */
export type AclSource = "request" | "upstream";

/** What to do when the target has no ACL to check against. */
export type OnMissingAcl = "deny" | "allow";

export interface AuthzOptions {
  enforce: AuthzEnforce;
  onError: AuthzOnError;
  identity: IdentitySpec;
  groups: GroupsRequestSpec;
  workflow: WorkflowACLSpec;
  /** Defaults to `request` so existing configurations behave as before. */
  aclSource?: AclSource;
  /** Cache lifetime for stored-workflow lookups. Short by design: a stale ACL is a stale permission. */
  aclCacheTtlMs?: number;
  /**
   * Applied when the target declares no ACL — including every `create`, which
   * has no stored state yet. `deny` refuses; `allow` lets it through.
   */
  onMissingAcl?: OnMissingAcl;
  /**
   * Groups permitted to act when the target has no ACL. Non-empty overrides
   * `onMissingAcl`: membership decides instead of a blanket answer, which is
   * what makes "anyone on the team may create, but only owners may edit"
   * expressible.
   */
  bootstrapGroups?: string[];
  /**
   * Actions this middleware authorizes. Empty means every action reaching it.
   * Names come from the proxy's route table.
   */
  actions?: string[];
}
