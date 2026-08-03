import { afterEach, describe, expect, it } from "bun:test";
import { callWebhook } from "../../src/api/webhook.ts";
import type { ClientMiddleware } from "../../src/middleware/types.ts";

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function stubFetch(status = 200, body = "ok"): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("callWebhook", () => {
  it("sends JSON with the default content headers", async () => {
    const calls = stubFetch();
    await callWebhook("https://gw.example.com/webhook/x", {
      method: "POST",
      data: { a: 1 },
      timeoutMs: 1000,
    });

    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(calls[0]?.body).toBe('{"a":1}');
  });

  it("omits the body when no data is given", async () => {
    const calls = stubFetch();
    await callWebhook("https://gw.example.com/webhook/x", { method: "GET", timeoutMs: 1000 });
    expect(calls[0]?.body).toBeNull();
  });

  it("runs the middleware chain in order, letting later entries see earlier headers", async () => {
    const calls = stubFetch();
    const first: ClientMiddleware = {
      name: "first",
      apply: (h) => {
        h.set("X-Step", "1");
      },
    };
    const second: ClientMiddleware = {
      name: "second",
      apply: (h) => {
        h.set("X-Step", `${h.get("X-Step")},2`);
      },
    };

    await callWebhook("https://gw.example.com/webhook/x", {
      method: "POST",
      timeoutMs: 1000,
      clientMiddlewares: [first, second],
    });

    expect(calls[0]?.headers.get("X-Step")).toBe("1,2");
  });

  it("lets middleware override a caller-supplied header", async () => {
    const calls = stubFetch();
    const mw: ClientMiddleware = {
      name: "auth",
      apply: (h) => {
        h.set("Authorization", "Bearer minted");
      },
    };

    await callWebhook("https://gw.example.com/webhook/x", {
      method: "POST",
      timeoutMs: 1000,
      headers: { Authorization: "Bearer stale" },
      clientMiddlewares: [mw],
    });

    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer minted");
  });

  it("propagates a middleware failure without sending the request", async () => {
    const calls = stubFetch();
    const mw: ClientMiddleware = {
      name: "boom",
      apply: () => {
        throw new Error("no credentials");
      },
    };

    await expect(
      callWebhook("https://gw.example.com/webhook/x", {
        method: "POST",
        timeoutMs: 1000,
        clientMiddlewares: [mw],
      }),
    ).rejects.toThrow("no credentials");
    expect(calls).toHaveLength(0);
  });

  it("returns non-2xx responses instead of throwing", async () => {
    stubFetch(403, "Forbidden");
    const res = await callWebhook("https://gw.example.com/webhook/x", {
      method: "POST",
      timeoutMs: 1000,
    });
    expect(res).toEqual({ status: 403, body: "Forbidden" });
  });

  it("wraps a transport failure with context", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      callWebhook("https://gw.example.com/webhook/x", { method: "POST", timeoutMs: 1000 }),
    ).rejects.toThrow("webhook request failed: ECONNREFUSED");
  });
});
