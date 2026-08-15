/**
 * Read routes where the proxy can resolve a single workflow and enforce n8n
 * project membership before forwarding to upstream.
 */

export interface WorkflowRead {
  action: "read";
  id: string;
}

const READ_PATTERN = /^\/api\/v1\/workflows\/([^/]+)$/;

/**
 * Matches GET requests for a single workflow by id. List endpoints and
 * unrelated paths return null and are forwarded without a project-role check.
 */
export function matchWorkflowRead(method: string, pathname: string): WorkflowRead | null {
  if (method.toUpperCase() !== "GET") return null;
  const normalized = pathname.replace(/\/+$/, "");
  const hit = normalized.match(READ_PATTERN);
  if (!hit?.[1]) return null;
  return { action: "read", id: decodeURIComponent(hit[1]) };
}
