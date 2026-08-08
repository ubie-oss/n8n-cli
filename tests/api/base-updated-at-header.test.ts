import { describe, expect, it, mock } from "bun:test";
import { Client } from "@/api/client.ts";
import { BASE_UPDATED_AT_HEADER } from "@/api/headers.ts";
import type { WorkflowInput } from "@/api/types.ts";
import { WorkflowService } from "@/api/workflow-service.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";

/**
 * The base-revision header, on the wire.
 *
 * The apply-level tests stop at the WorkflowService boundary, so without this
 * the claim "apply declares the revision it was built on" is never checked
 * against an actual request — and the proxy guard is useless if the header
 * never leaves the client.
 */

function captureRequests(): { headers: Headers[]; restore: () => void } {
  const headers: Headers[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_input: unknown, init: RequestInit) => {
    headers.push(new Headers(init.headers));
    return new Response(JSON.stringify({ id: "wf1" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { headers, restore: () => (globalThis.fetch = originalFetch) };
}

const INPUT: WorkflowInput = { name: "wf", nodes: [], connections: {} };

describe("updateWorkflow base revision", () => {
  it("sends the declared base revision", async () => {
    const { headers, restore } = captureRequests();
    try {
      const service = new WorkflowService(new Client("https://n8n.example.com", "key"));
      await service.updateWorkflow("wf1", INPUT, "2026-03-01T10:00:00.000Z");
      expect(headers[0]?.get(BASE_UPDATED_AT_HEADER)).toBe("2026-03-01T10:00:00.000Z");
    } finally {
      restore();
    }
  });

  it("sends nothing when the caller has no base to declare", async () => {
    const { headers, restore } = captureRequests();
    try {
      const service = new WorkflowService(new Client("https://n8n.example.com", "key"));
      await service.updateWorkflow("wf1", INPUT);
      expect(headers[0]?.has(BASE_UPDATED_AT_HEADER)).toBe(false);
    } finally {
      restore();
    }
  });

  it("leaves the standard headers alone", async () => {
    const { headers, restore } = captureRequests();
    try {
      const service = new WorkflowService(new Client("https://n8n.example.com", "key"));
      await service.updateWorkflow("wf1", INPUT, "2026-03-01T10:00:00.000Z");
      expect(headers[0]?.get("X-N8N-API-KEY")).toBe("key");
      expect(headers[0]?.get("Content-Type")).toBe("application/json");
    } finally {
      restore();
    }
  });

  it("runs before the egress middlewares, so a gateway chain can still override", async () => {
    const { headers, restore } = captureRequests();
    const middleware: ClientMiddleware = {
      name: "test",
      apply(h) {
        h.set(BASE_UPDATED_AT_HEADER, "rewritten");
      },
    };
    try {
      const service = new WorkflowService(
        new Client("https://n8n.example.com", "key", 30_000, [middleware]),
      );
      await service.updateWorkflow("wf1", INPUT, "2026-03-01T10:00:00.000Z");
      expect(headers[0]?.get(BASE_UPDATED_AT_HEADER)).toBe("rewritten");
    } finally {
      restore();
    }
  });
});
