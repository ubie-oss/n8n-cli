/** Built-in n8n project roles exposed through the public API. */
export const PROJECT_ROLE_ADMIN = "project:admin";
export const PROJECT_ROLE_EDITOR = "project:editor";
export const PROJECT_ROLE_VIEWER = "project:viewer";

/** Instance roles that bypass per-project membership checks. */
export const INSTANCE_ROLE_OWNER = "global:owner";
export const INSTANCE_ROLE_ADMIN = "global:admin";

export type AccessLevel = "read" | "write";

const WRITE_ROLES = new Set([PROJECT_ROLE_ADMIN, PROJECT_ROLE_EDITOR]);
const READ_ROLES = new Set([PROJECT_ROLE_ADMIN, PROJECT_ROLE_EDITOR, PROJECT_ROLE_VIEWER]);

/** True when an instance-level role grants access regardless of project membership. */
export function isInstanceWideAdmin(role: string | null | undefined): boolean {
  return role === INSTANCE_ROLE_OWNER || role === INSTANCE_ROLE_ADMIN;
}

/** True when a project role satisfies the requested access level. Unknown slugs deny. */
export function projectRoleSatisfies(role: string | null | undefined, level: AccessLevel): boolean {
  if (!role) return false;
  if (level === "write") return WRITE_ROLES.has(role);
  return READ_ROLES.has(role);
}
