/** Recognized n8n public-API endpoints that mutate workflow definitions. */
export type WorkflowMutation =
  | { kind: "create" } // POST /api/v1/workflows
  | { kind: "update"; id: string }; // PUT /api/v1/workflows/:id

/**
 * Identifies if a request targets a workflow mutation endpoint on the public
 * n8n API. Returns null for any other request (which should be transparently
 * forwarded).
 */
export function matchWorkflowMutation(method: string, pathname: string): WorkflowMutation | null {
  const normalized = pathname.replace(/\/+$/, "");

  if (method === "POST" && normalized === "/api/v1/workflows") {
    return { kind: "create" };
  }

  if (method === "PUT") {
    const m = normalized.match(/^\/api\/v1\/workflows\/([^/]+)$/);
    if (m) return { kind: "update", id: decodeURIComponent(m[1] as string) };
  }

  return null;
}
