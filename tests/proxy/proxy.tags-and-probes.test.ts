import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

interface CapturedRequest {
  method: string;
  pathname: string;
  body: string;
}

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: CapturedRequest[];
}

function startMockUpstream(): MockUpstream {
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      captured.push({ method: req.method, pathname: url.pathname, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { server, port: server.port as number, captured };
}

let proxy: ProxyHandle;
let upstream: MockUpstream;

beforeEach(() => {
  upstream = startMockUpstream();
});

afterEach(async () => {
  await proxy?.stop();
  upstream.server.stop(true);
});

function start(extra: Partial<Parameters<typeof startProxy>[0]> = {}): ProxyHandle {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    enforce: "error",
    disableRules: [],
    logFormat: "json",
    allowDuplicates: true,
    ...extra,
  });
  return proxy;
}

function url(p: string): string {
  return `http://127.0.0.1:${proxy.port}${p}`;
}

const VIOLATING_BODY = JSON.stringify({
  // missing "name" → required-fields error
  active: true,
  nodes: [],
  connections: {},
});

const VIOLATING_WITH_TAGS = (tags: Array<{ name: string }>) =>
  JSON.stringify({
    active: true,
    nodes: [],
    connections: {},
    tags,
  });

describe("proxy: tag-based scope filter", () => {
  test("workflow without matching tags is forwarded transparently (no lint block)", async () => {
    start({ filterByTags: ["managed"] });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VIOLATING_BODY, // would normally 422 — but outside scope
    });

    expect(res.status).toBe(200);
    expect(upstream.captured.filter((c) => c.method === "POST")).toHaveLength(1);
    // Body forwarded verbatim
    const forwarded = upstream.captured.find((c) => c.method === "POST");
    expect(forwarded?.body).toBe(VIOLATING_BODY);
  });

  test("workflow with all required tags is processed by middleware", async () => {
    start({ filterByTags: ["managed"] });

    const body = VIOLATING_WITH_TAGS([{ name: "managed" }]);
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(422);
    const parsed = (await res.json()) as { error: string };
    expect(parsed.error).toBe("workflow_lint_failed");
    expect(upstream.captured.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("AND condition: missing one of multiple required tags is skipped", async () => {
    start({ filterByTags: ["managed", "prod"] });

    const body = VIOLATING_WITH_TAGS([{ name: "managed" }]); // missing "prod"
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(200); // forwarded
  });

  test("AND condition: all required tags present → middleware applied", async () => {
    start({ filterByTags: ["managed", "prod"] });

    const body = VIOLATING_WITH_TAGS([{ name: "managed" }, { name: "prod" }, { name: "extra" }]);
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(422);
  });

  test("filter applies to PUT updates as well", async () => {
    start({ filterByTags: ["managed"] });

    const res = await fetch(url("/api/v1/workflows/wf-1"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: VIOLATING_BODY, // no tags, skipped
    });

    expect(res.status).toBe(200);
    expect(upstream.captured.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  test("undefined filterByTags preserves legacy behavior (all saves checked)", async () => {
    start(); // no filterByTags

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VIOLATING_BODY,
    });

    expect(res.status).toBe(422);
  });
});

describe("proxy: liveness/readiness probes", () => {
  test("GET /livez returns 200", async () => {
    start();
    const res = await fetch(url("/livez"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok");
    expect(upstream.captured).toHaveLength(0);
  });

  test("HEAD /livez returns 200 with no body", async () => {
    start();
    const res = await fetch(url("/livez"), { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  test("GET /readyz returns 200 once middleware prepare() resolves", async () => {
    start();
    // prepare() runs at startup; for the lint middleware it's synchronous,
    // so by the time we issue the request the proxy should already be ready.
    // Allow a microtask to flush before polling.
    await Bun.sleep(20);

    const res = await fetch(url("/readyz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ready");
    expect(upstream.captured).toHaveLength(0);
  });

  test("HEAD /readyz returns 200 with no body once ready", async () => {
    start();
    await Bun.sleep(20);

    const res = await fetch(url("/readyz"), { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  test("legacy /healthz still returns 200", async () => {
    start();
    const res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(0);
  });

  test("non-GET/HEAD methods on probe paths fall through to forwarding", async () => {
    start();
    // POST /healthz isn't a probe; it should be forwarded transparently.
    const res = await fetch(url("/healthz"), { method: "POST", body: "x" });
    // The upstream returned 200 from the mock.
    expect(res.status).toBe(200);
    expect(upstream.captured.some((c) => c.pathname === "/healthz" && c.method === "POST")).toBe(
      true,
    );
  });

  test("/readyz returns 503 + stderr log when middleware prepare() fails", async () => {
    // Point lint config at a path that exists but contains invalid JSON so
    // prepareWriteLintContext throws — this is the canonical operator
    // misconfiguration the old code crashed on at startup.
    const badConfig = `${process.env.TMPDIR ?? "/tmp"}/n8n-cli-broken-lint-${Date.now()}.json`;
    await Bun.write(badConfig, "{ not valid json");

    // Capture console.error so we can assert the failure was surfaced
    // loudly even for deployments that don't probe /readyz.
    const originalConsoleError = console.error;
    const stderrLines: string[] = [];
    console.error = (...args: unknown[]) => {
      stderrLines.push(args.map((a) => String(a)).join(" "));
    };

    try {
      start({ lintConfigPath: badConfig });
      // Let the prepare() promise resolve.
      await Bun.sleep(50);

      const res = await fetch(url("/readyz"));
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toContain("not ready");
      expect(body).toContain("lint");

      // Stderr saw the failure too.
      expect(stderrLines.join("\n")).toMatch(/middleware "lint" prepare\(\) failed/);

      // /livez is unaffected — the process is alive even when not ready.
      const livez = await fetch(url("/livez"));
      expect(livez.status).toBe(200);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
