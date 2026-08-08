import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BASE_UPDATED_AT_HEADER, STALE_WRITE_WARNING_HEADER } from "@/api/headers.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * End-to-end tests for the proxy with the stale-write guard enabled.
 *
 * The scenario under test is the one lint and authz both wave through: a
 * well-formed, authorized update built from an out-of-date checkout, which
 * would silently revert whatever was changed upstream in the meantime.
 *
 * The mock upstream answers `GET /workflows/:id` with a fixed `updatedAt` and
 * records every request, so each test can assert both what the client got back
 * and whether the write reached n8n at all.
 */

const STORED = "2026-03-01T10:00:00.000Z";
const OLDER = "2026-02-01T10:00:00.000Z";

interface Captured {
  method: string;
  path: string;
  baseHeader: string | null;
}

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: Captured[];
}

function startMockUpstream(storedStamp: string = STORED): MockUpstream {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      await req.text();
      captured.push({
        method: req.method,
        path: url.pathname,
        baseHeader: req.headers.get(BASE_UPDATED_AT_HEADER),
      });

      if (req.method === "GET" && url.pathname === "/api/v1/workflows/wf1") {
        return Response.json({
          id: "wf1",
          name: "stored",
          nodes: [],
          connections: {},
          updatedAt: storedStamp,
        });
      }
      return Response.json({ ok: true });
    },
  });
  return { server, port: server.port as number, captured };
}

let upstream: MockUpstream;
let proxy: ProxyHandle;

beforeEach(() => {
  upstream = startMockUpstream();
});

afterEach(async () => {
  await proxy?.stop();
  upstream.server.stop(true);
});

function startProxyWithGuard(cliOptions: Record<string, string> = {}): ProxyHandle {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    // Lint and the duplicate check are off so only the guard can reject.
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    middlewares: ["stale-write"],
    middlewareCliOptions: { staleWriteEnforce: "error", ...cliOptions },
  });
  return proxy;
}

function put(base?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (base) headers[BASE_UPDATED_AT_HEADER] = base;
  return fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ name: "local", nodes: [], connections: {} }),
  });
}

/** Requests the proxy forwarded, excluding its own stored-state lookups. */
function forwardedWrites(): Captured[] {
  return upstream.captured.filter((c) => c.method !== "GET");
}

describe("proxy + stale-write", () => {
  test("a current base is forwarded", async () => {
    startProxyWithGuard();

    const res = await put(STORED);

    expect(res.status).toBe(200);
    expect(forwardedWrites()).toHaveLength(1);
  });

  test("a stale base is rejected with 409 and never reaches upstream", async () => {
    startProxyWithGuard();

    const res = await put(OLDER);
    const body = (await res.json()) as { error: string; message: string };

    expect(res.status).toBe(409);
    expect(body.error).toBe("workflow_stale_write");
    expect(body.message).toContain(STORED);
    expect(forwardedWrites()).toHaveLength(0);
  });

  test("the control header is stripped before the write reaches n8n", async () => {
    startProxyWithGuard();

    await put(STORED);

    expect(forwardedWrites()[0]?.baseHeader).toBeNull();
  });

  test("warn mode forwards the write but flags it on the response", async () => {
    startProxyWithGuard({ staleWriteEnforce: "warn" });

    const res = await put(OLDER);

    expect(res.status).toBe(200);
    expect(res.headers.get(STALE_WRITE_WARNING_HEADER)).toContain(STORED);
    expect(forwardedWrites()).toHaveLength(1);
  });

  test("warn mode survives an upstream timestamp that cannot go in a header", async () => {
    // The message quotes the upstream `updatedAt` verbatim. A control
    // character in it used to make `Headers.set` throw, and the throw landed in
    // the forwarding catch — turning a write upstream had already accepted into
    // a 502 for the client.
    upstream.server.stop(true);
    upstream = startMockUpstream("2026-03-01T10:00:00.000Z\r\ninjected: yes \u65e5");
    startProxyWithGuard({ staleWriteEnforce: "warn" });

    const res = await put(OLDER);

    expect(res.status).toBe(200);
    expect(res.headers.get("injected")).toBeNull();
    // Non-Latin-1 is rejected by `Headers.set` just as control characters are.
    expect(res.headers.get(STALE_WRITE_WARNING_HEADER)).not.toContain("\u65e5");
    expect(forwardedWrites()).toHaveLength(1);
  });

  test("a stale-write warning is not counted as a lint failure", async () => {
    // A CI step gating on x-n8n-lint-errors is the documented lint rollout
    // path. Folding stale writes into it would fail builds for writes warn mode
    // deliberately let through, and blame lint for them.
    startProxyWithGuard({ staleWriteEnforce: "warn" });

    const res = await put(OLDER);

    expect(res.headers.get(STALE_WRITE_WARNING_HEADER)).not.toBeNull();
    expect(res.headers.get("x-n8n-lint-violations")).toBeNull();
    expect(res.headers.get("x-n8n-lint-errors")).toBeNull();
  });

  test("a write with no base header passes by default", async () => {
    startProxyWithGuard();

    const res = await put();

    expect(res.status).toBe(200);
    expect(forwardedWrites()).toHaveLength(1);
  });

  test("onMissingBase=deny closes the gap for callers that declare nothing", async () => {
    startProxyWithGuard({ staleWriteOnMissingBase: "deny" });

    const res = await put();

    expect(res.status).toBe(409);
    expect(forwardedWrites()).toHaveLength(0);
  });

  test("creates are out of scope — there is no stored state to revert", async () => {
    startProxyWithGuard({ staleWriteOnMissingBase: "deny" });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new", nodes: [], connections: {} }),
    });

    expect(res.status).toBe(200);
    expect(forwardedWrites()).toHaveLength(1);
  });

  test("routes carrying no workflow body are still guarded when in scope", async () => {
    startProxyWithGuard({ staleWriteActions: "update,tags" });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows/wf1/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json", [BASE_UPDATED_AT_HEADER]: OLDER },
      body: JSON.stringify([{ id: "tag1" }]),
    });

    expect(res.status).toBe(409);
    expect(forwardedWrites()).toHaveLength(0);
  });
});
