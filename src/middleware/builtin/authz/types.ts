import type { IdentitySpec } from "@/middleware/identity.ts";

/**
 * Configuration for fetching the actor's group memberships from an HTTP
 * service. Every field is user-supplied so the middleware has no built-in
 * knowledge of any specific groups API.
 */
export interface GroupsRequestSpec {
  url: string;
  method: string;
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

export interface AuthzOptions {
  enforce: AuthzEnforce;
  onError: AuthzOnError;
  identity: IdentitySpec;
  groups: GroupsRequestSpec;
  workflow: WorkflowACLSpec;
}
