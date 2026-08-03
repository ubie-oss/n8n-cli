/**
 * The set of upstream endpoints the proxy treats as policy-relevant.
 *
 * Anything not matched here is forwarded transparently, so this table decides
 * what middleware can see at all. It is configurable (`--routes` /
 * `N8N_PROXY_ROUTES`) because the surface worth gating is deployment specific:
 * a self-hosted n8n variant, a future API version, or an operator who also
 * wants credential writes under policy shouldn't need a new release.
 */

export interface RouteSpec {
  method: string;
  /** Path with `:id` standing for exactly one path segment. */
  pattern: string;
  /** Action name handed to middleware as `ctx.action`. */
  action: string;
  /**
   * Whether the request body is a workflow definition. Tag assignment, delete
   * and activate carry something else (or nothing), so body-reading middleware
   * (lint) must stay out of their way.
   */
  bodyIsWorkflow: boolean;
}

export interface WorkflowMutation {
  action: string;
  /** Workflow id from the path, when the route carries one. */
  id?: string;
  bodyIsWorkflow: boolean;
}

/**
 * Default table: the endpoints that change a workflow, or change who may
 * reach it. `create`/`update` carry a workflow body; the rest do not.
 */
export const DEFAULT_ROUTES: RouteSpec[] = [
  { method: "POST", pattern: "/api/v1/workflows", action: "create", bodyIsWorkflow: true },
  { method: "PUT", pattern: "/api/v1/workflows/:id", action: "update", bodyIsWorkflow: true },
  // Tag assignment is its own endpoint upstream and n8n ignores tags on the
  // workflow body, so an ACL kept in tags can only be defended here.
  { method: "PUT", pattern: "/api/v1/workflows/:id/tags", action: "tags", bodyIsWorkflow: false },
  { method: "DELETE", pattern: "/api/v1/workflows/:id", action: "delete", bodyIsWorkflow: false },
  {
    method: "POST",
    pattern: "/api/v1/workflows/:id/activate",
    action: "activate",
    bodyIsWorkflow: false,
  },
  {
    method: "POST",
    pattern: "/api/v1/workflows/:id/deactivate",
    action: "activate",
    bodyIsWorkflow: false,
  },
];

/**
 * Parses a route table from text. One route per line (or comma-separated):
 *
 *   METHOD /path/:id -> action [body=workflow]
 *
 * `#` starts a comment. Malformed lines throw instead of being skipped — a
 * typo that silently dropped a route would silently drop enforcement.
 */
export function parseRoutes(raw: string | undefined): RouteSpec[] | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const lines = raw
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) return undefined;

  return lines.map((line) => {
    const m = line.match(/^(\S+)\s+(\S+)\s*->\s*(\S+)(?:\s+body=(\S+))?$/);
    if (!m) {
      throw new Error(
        `Invalid proxy route "${line}". Expected: METHOD /path/:id -> action [body=workflow]`,
      );
    }
    return {
      method: (m[1] as string).toUpperCase(),
      pattern: m[2] as string,
      action: m[3] as string,
      bodyIsWorkflow: m[4] === "workflow",
    };
  });
}

/**
 * Resolves the effective route table from the two knobs the proxy exposes.
 *
 * `--routes` replaces the table wholesale, which is right when an operator is
 * describing a different API surface, but wrong for the common case of adding
 * one endpoint: restating the five workflow-mutation routes just to append a
 * sixth means a later change to the defaults silently misses this deployment.
 * `--extra-routes` appends instead, so a deployment can bring one more path
 * under policy without pinning the rest.
 *
 * Extras append *after* the base, so a base route always wins a tie — an
 * appended entry cannot quietly reclassify an endpoint that is already gated.
 */
export function resolveRouteTable(
  explicitRaw: string | undefined,
  extraRaw: string | undefined,
): RouteSpec[] | undefined {
  const explicit = parseRoutes(explicitRaw);
  const extra = parseRoutes(extraRaw);
  if (!extra) return explicit;
  return [...(explicit ?? DEFAULT_ROUTES), ...extra];
}

function matchPattern(pattern: string, pathname: string): { id?: string } | null {
  const pParts = pattern.split("/");
  const aParts = pathname.split("/");
  if (pParts.length !== aParts.length) return null;
  let id: string | undefined;
  for (let i = 0; i < pParts.length; i++) {
    const p = pParts[i] as string;
    const a = aParts[i] as string;
    if (p === ":id") {
      if (a === "") return null;
      id = decodeURIComponent(a);
      continue;
    }
    if (p !== a) return null;
  }
  return { id };
}

/**
 * Identifies whether a request targets a policy-relevant endpoint. Returns
 * null for everything else, which the caller forwards transparently.
 */
export function matchWorkflowMutation(
  method: string,
  pathname: string,
  routes: RouteSpec[] = DEFAULT_ROUTES,
): WorkflowMutation | null {
  const normalized = pathname.replace(/\/+$/, "");
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const hit = matchPattern(route.pattern, normalized);
    if (!hit) continue;
    return { action: route.action, id: hit.id, bodyIsWorkflow: route.bodyIsWorkflow };
  }
  return null;
}
