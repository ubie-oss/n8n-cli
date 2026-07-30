import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@/api/client.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";

/**
 * The API client's egress seam.
 *
 * Without it the CLI can only ever send `X-N8N-API-KEY`, so it cannot reach a
 * gateway that authenticates callers per request — the request is rejected at
 * the edge before n8n is involved at all.
 */

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
}

let captured: Captured[];
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeEach(() => {
  captured = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({ method: req.method, url: req.url, headers });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop(true);
});

/** Middleware that stands in for iap-auth / impersonator-token. */
function fakeAuth(): ClientMiddleware {
  return {
    name: "fake-auth",
    apply(headers, ctx) {
      headers.set("Authorization", `Bearer token-for-${ctx.method}`);
      headers.set("X-Impersonator-Id-Token", "user-token");
      headers.set("X-Saw-Path", ctx.pathname);
    },
  };
}

describe("Client egress middlewares", () => {
  test("no chain configured leaves the request exactly as before", async () => {
    const client = new Client(base, "key-123");
    await client.get("/workflows");

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.headers["x-n8n-api-key"]).toBe("key-123");
    expect(req.headers.authorization).toBeUndefined();
  });

  test("configured middlewares can attach credentials to every call", async () => {
    const client = new Client(base, "key-123", 30_000, [fakeAuth()]);
    await client.get("/workflows");
    await client.post("/workflows", { name: "wf" });

    expect(captured).toHaveLength(2);
    for (const req of captured) {
      expect(req.headers.authorization).toBe(`Bearer token-for-${req.method}`);
      expect(req.headers["x-impersonator-id-token"]).toBe("user-token");
      // The API key still rides along; a gateway may replace it upstream.
      expect(req.headers["x-n8n-api-key"]).toBe("key-123");
    }
    // Context reflects the actual outgoing request, not a placeholder.
    expect(captured[0]!.headers["x-saw-path"]).toBe("/api/v1/workflows");
  });

  test("a middleware that throws aborts the call instead of sending it unauthenticated", async () => {
    const boom: ClientMiddleware = {
      name: "boom",
      apply() {
        throw new Error("mint failed");
      },
    };
    const client = new Client(base, "key-123", 30_000, [boom]);

    await expect(client.get("/workflows")).rejects.toThrow(/mint failed/);
    expect(captured).toHaveLength(0);
  });

  test("requests ask for an identity encoding so a re-labelling proxy cannot break reads", async () => {
    const client = new Client(base, "key-123");
    await client.get("/workflows");

    expect(captured[0]!.headers["accept-encoding"]).toBe("identity");
  });
});
