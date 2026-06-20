import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseListenAddr } from "@/proxy/config.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";

interface CapturedRequest {
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  captured: CapturedRequest[];
  /** Override the workflow listing returned for the next GET /api/v1/workflows. */
  setWorkflows: (workflows: Array<{ id: string; name: string; active?: boolean }>) => void;
  /** Make the next request hang forever, simulating a stuck upstream. */
  hangNext: () => void;
}

function startMockUpstream(): MockUpstream {
  const captured: CapturedRequest[] = [];
  let workflows: Array<{ id: string; name: string; active?: boolean }> = [];
  let hang = false;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      captured.push({ method: req.method, pathname: url.pathname, headers, body });

      if (hang) {
        return new Promise<Response>(() => {
          /* never resolves */
        });
      }

      if (req.method === "GET" && url.pathname === "/api/v1/workflows") {
        return new Response(JSON.stringify({ data: workflows, nextCursor: null }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    server,
    port: server.port as number,
    captured,
    setWorkflows(w) {
      workflows = w;
    },
    hangNext() {
      hang = true;
    },
  };
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
    ...extra,
  });
  return proxy;
}

function url(p: string): string {
  return `http://127.0.0.1:${proxy.port}${p}`;
}

const VIOLATING = JSON.stringify({ active: true, nodes: [], connections: {} });

describe("proxy: parseListenAddr", () => {
  test("rejects port with trailing garbage", () => {
    expect(() => parseListenAddr(":8080abc")).toThrow(/expected digits only/);
  });

  test("accepts bracketed IPv6", () => {
    expect(parseListenAddr("[::1]:9000")).toEqual({ host: "::1", port: 9000 });
  });

  test("rejects bracketed IPv6 missing port", () => {
    expect(() => parseListenAddr("[::1]")).toThrow();
  });

  test(":port resolves to 0.0.0.0", () => {
    expect(parseListenAddr(":8080")).toEqual({ host: "0.0.0.0", port: 8080 });
  });
});

describe("proxy: malformed JSON", () => {
  test("returns 400 from the proxy, never forwards", async () => {
    start();

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"x","nodes', // truncated
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; parseError?: string };
    expect(body.error).toBe("workflow_invalid_json");
    expect(upstream.captured.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("proxy: 422 body includes warnings", () => {
  test("warnings appear alongside errors in the 422 violations array", async () => {
    // banned-node defaults to warning. Combine with required-fields (error) by
    // providing an empty name + a node of a banned type.
    const cfg: Record<string, unknown> = {
      "banned-node": ["warning", { nodes: [{ type: "n8n-nodes-base.httpRequest" }] }],
    };
    const lintPath = `${process.env.TMPDIR ?? "/tmp"}/n8n-cli-warn-test-${Date.now()}.json`;
    await Bun.write(lintPath, JSON.stringify({ rules: cfg }));
    start({ lintConfigPath: lintPath });

    const body = JSON.stringify({
      // missing name → required-fields error
      active: true,
      nodes: [
        {
          id: "n1",
          name: "HTTP",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 1,
          position: [0, 0],
        },
      ],
      connections: {},
    });
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(422);
    const parsed = (await res.json()) as {
      violations: Array<{ rule: string; severity: string }>;
    };
    const severities = new Set(parsed.violations.map((v) => v.severity));
    expect(severities.has("error")).toBe(true);
    expect(severities.has("warning")).toBe(true);
  });
});

describe("proxy: linter exception is caught", () => {
  test("workflow lacking required structure does not crash with 500", async () => {
    start();
    // A workflow shape that some rules iterate on but is missing nodes.
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", connections: {} }),
    });
    // The required-fields rule will flag the missing nodes; even if a rule
    // throws on it, the proxy returns 422 (not 500).
    expect([400, 422]).toContain(res.status);
  });
});

describe("proxy: HEAD /healthz", () => {
  test("responds locally with 200, never forwards", async () => {
    start();
    const res = await fetch(url("/healthz"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(0);
  });
});

describe("proxy: hop-by-hop headers", () => {
  test("Transfer-Encoding and Connection-listed headers are stripped", async () => {
    start({ enforce: "off" });
    await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Connection lists "x-custom-hop"; that header must also be stripped.
        connection: "close, x-custom-hop",
        "x-custom-hop": "secret",
        te: "trailers",
      },
      body: VIOLATING,
    });
    const forwarded = upstream.captured.find((c) => c.method === "POST");
    expect(forwarded).toBeDefined();
    // The Connection header from fetch's own network layer may still be
    // present (e.g. "keep-alive"). What we care about is that we stripped
    // the original client values: "close" and the listed x-custom-hop header.
    expect(forwarded?.headers.connection ?? "").not.toContain("close");
    expect(forwarded?.headers.connection ?? "").not.toContain("x-custom-hop");
    expect(forwarded?.headers.te).toBeUndefined();
    expect(forwarded?.headers["x-custom-hop"]).toBeUndefined();
  });
});

describe("proxy: upstream timeout", () => {
  test("hung upstream produces a 502 within the timeout", async () => {
    upstream.hangNext();
    start({ upstreamTimeoutMs: 250 });

    const start_t = performance.now();
    const res = await fetch(url("/api/v1/workflows"), { method: "GET" });
    const elapsed = performance.now() - start_t;

    expect(res.status).toBe(502);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);
});

describe("proxy: --warn-duplicates", () => {
  test("enforce=error blocks with 409 when name already exists upstream", async () => {
    upstream.setWorkflows([{ id: "wf-existing", name: "My Workflow", active: true }]);
    start({ warnDuplicates: true });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: JSON.stringify({ name: "My Workflow", nodes: [], connections: {} }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; duplicates: unknown[] };
    expect(body.error).toBe("workflow_duplicate_name");
    expect(body.duplicates).toHaveLength(1);
    // POST never reached upstream (only the GET that built the index).
    expect(upstream.captured.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("enforce=warn attaches a duplicate-warning header and still forwards", async () => {
    upstream.setWorkflows([{ id: "wf-existing", name: "Same Name", active: false }]);
    start({ warnDuplicates: true, enforce: "warn" });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: JSON.stringify({ name: "Same Name", nodes: [], connections: {} }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-n8n-duplicate-warning")).toBe("1");
    expect(upstream.captured.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("PUT (update) is never duplicate-checked", async () => {
    upstream.setWorkflows([{ id: "wf-existing", name: "X", active: false }]);
    start({ warnDuplicates: true });

    const res = await fetch(url("/api/v1/workflows/wf-existing"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", nodes: [], connections: {} }),
    });

    // No duplicate-related block on update.
    expect(res.status).toBe(200);
  });

  test("no upstream match → forwards normally", async () => {
    upstream.setWorkflows([{ id: "wf-other", name: "Different", active: false }]);
    start({ warnDuplicates: true });

    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Brand New", nodes: [], connections: {} }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-n8n-duplicate-warning")).toBeNull();
  });
});

describe("proxy: enforce=off short-circuits lint", () => {
  test("violating workflow forwards without running rules", async () => {
    start({ enforce: "off" });
    const res = await fetch(url("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VIOLATING,
    });
    expect(res.status).toBe(200);
    // No lint headers on the forwarded response, because evaluate returns
    // an empty violations array under enforce=off.
    expect(res.headers.get("x-n8n-lint-violations")).toBeNull();
  });
});
