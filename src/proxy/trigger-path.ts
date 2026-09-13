/**
 * n8n's inbound HTTP trigger prefixes — webhook, form, waiting, and the
 * per-workflow MCP trigger.
 *
 * These are n8n's own URL surface (the `N8N_ENDPOINT_*` defaults), not a
 * deployment naming convention. The proxy uses them only to label the
 * existing audit-log line; it does not gate or rewrite the request.
 *
 * Instance MCP (`/mcp-server/`) is a different surface and is classified
 * first in `handle()`. `/mcp` here is the per-workflow MCP trigger path,
 * which does not share a prefix with `/mcp-server`.
 *
 * Prefixes are matched as a path segment: `/webhook` matches `/webhook` and
 * `/webhook/foo`, but not `/webhook-waiting` or `/webhooks`.
 */
export const TRIGGER_PATH_PREFIXES = [
  "/webhook-waiting",
  "/webhook-test",
  "/webhook",
  "/form-waiting",
  "/form-test",
  "/form",
  "/mcp-test",
  "/mcp",
] as const;

/** True when this request is one of n8n's inbound HTTP trigger URLs. */
export function isTriggerPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return TRIGGER_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}
