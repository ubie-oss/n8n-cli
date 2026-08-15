import type { IdentitySpec } from "@/middleware/identity.ts";

export type ProjectRoleEnforce = "off" | "warn" | "error";
export type ProjectRoleOnError = "deny" | "allow";
export type ProjectRoleOnMissingProject = "deny" | "allow";

export interface ProjectRoleOptions {
  enforce: ProjectRoleEnforce;
  /** Behavior when n8n membership lookups fail. */
  onError: ProjectRoleOnError;
  /**
   * What to do when the target workflow has no project id (typical on create).
   * n8n assigns those to the caller's personal project upstream; the proxy
   * cannot see that mapping without an extra round trip.
   */
  onMissingProject: ProjectRoleOnMissingProject;
  /** Where to read the actor email when oauth-verify did not populate ctx.identity. */
  identity: IdentitySpec;
  /** Cache TTL for project member lists (milliseconds). */
  membersCacheTtlMs: number;
  /** Cache TTL for instance user roles (milliseconds). */
  instanceRoleCacheTtlMs: number;
  /** HTTP timeout for n8n membership lookups. */
  timeoutMs: number;
  /**
   * When non-empty, only these route actions run the check. Empty means every
   * action the host hands us (create, update, delete, activate, tags, read).
   */
  actions: string[];
}
