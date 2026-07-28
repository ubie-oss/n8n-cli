import { afterEach, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

/**
 * Regression tests for forwarding compressed upstream responses.
 *
 * `fetch` decodes the upstream body on its own but leaves `Content-Encoding`
 * and the compressed `Content-Length` on the Response. Passing those through
 * hands the client a plain body labelled `content-encoding: gzip`, which any
 * client that honours the header fails to decode.
 */

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
}

/** Upstream that answers with a gzip-encoded JSON body, as n8n's LB does. */
function startCompressingUpstream(payload: unknown): MockUpstream {
  const raw = Buffer.from(JSON.stringify(payload));
  const gzipped = Bun.gzipSync(raw);
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(gzipped, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-encoding": "gzip",
          // The compressed length — exactly what makes a verbatim forward wrong.
          "content-length": String(gzipped.byteLength),
          "x-upstream-marker": "kept",
        },
      }),
  });
  return { server, port: server.port! };
}

/** Upstream that answers uncompressed, to prove the pass-through path is untouched. */
function startPlainUpstream(payload: unknown): MockUpstream {
  const body = JSON.stringify(payload);
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body)),
          "x-upstream-marker": "kept",
        },
      }),
  });
  return { server, port: server.port! };
}

let upstream: MockUpstream | undefined;
let proxy: ProxyHandle | undefined;

afterEach(async () => {
  await proxy?.stop();
  await upstream?.server.stop(true);
  proxy = undefined;
  upstream = undefined;
});

function startProxyAgainst(port: number): ProxyHandle {
  return startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${port}`,
    enforce: "off",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
  });
}

describe("proxy: upstream response encoding", () => {
  test("a compressed upstream response reaches the client decodable", async () => {
    const payload = { data: [{ id: "abc123", name: "workflow" }], nextCursor: null };
    upstream = startCompressingUpstream(payload);
    proxy = startProxyAgainst(upstream.port);

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`, {
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    // The body must be readable — before the fix this threw a decompression error.
    expect(await res.json()).toEqual(payload);
    // And the misleading headers must be gone rather than describing a body we no longer send.
    expect(res.headers.get("content-encoding")).toBeNull();
    // Unrelated upstream headers survive the rebuild.
    expect(res.headers.get("x-upstream-marker")).toBe("kept");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("an uncompressed upstream response is forwarded untouched", async () => {
    const payload = { data: [], nextCursor: null };
    upstream = startPlainUpstream(payload);
    proxy = startProxyAgainst(upstream.port);

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/v1/workflows`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-upstream-marker")).toBe("kept");
  });
});
