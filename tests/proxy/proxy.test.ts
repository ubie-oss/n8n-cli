import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchWorkflowMutation } from "@/proxy/rest/router.ts";
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
  /** Override the response returned for the next request. */
  respondWith: (status: number, body: string, headers?: Record<string, string>) => void;
}

function startMockUpstream(): MockUpstream {
  const captured: CapturedRequest[] = [];
  let nextResponse: { status: number; body: string; headers: Record<string, string> } | null = null;

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

      if (nextResponse) {
        const r = nextResponse;
        nextResponse = null;
        return new Response(r.body, { status: r.status, headers: r.headers });
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
    respondWith(status, body, headers = {}) {
      nextResponse = { status, body, headers: { "content-type": "application/json", ...headers } };
    },
  };
}

const VIOLATING_WORKFLOW = JSON.stringify({
  // missing "name" → required-fields error
  active: true,
  nodes: [],
  connections: {},
});

const CLEAN_WORKFLOW = JSON.stringify({
  name: "Clean WF",
  active: false,
  nodes: [],
  connections: {},
});

let tmpDir: string;
let proxy: ProxyHandle;
let upstream: MockUpstream;

function writeConfig(rules: Record<string, unknown>): string {
  const configPath = path.join(tmpDir, ".n8nlintrc.json");
  fs.writeFileSync(configPath, JSON.stringify({ rules }));
  return configPath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-proxy-"));
  upstream = startMockUpstream();
});

afterEach(async () => {
  await proxy?.stop();
  upstream.server.stop(true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function startWithEnforce(enforce: "off" | "warn" | "error", configPath?: string): ProxyHandle {
  proxy = startProxy({
    listen: "127.0.0.1:0",
    upstream: `http://127.0.0.1:${upstream.port}`,
    lintConfigPath: configPath,
    enforce,
    disableRules: [],
    logFormat: "json",
  });
  return proxy;
}

function proxyURL(p: string): string {
  return `http://127.0.0.1:${proxy.port}${p}`;
}

describe("proxy: route matcher", () => {
  test("POST /api/v1/workflows is recognized as create", () => {
    expect(matchWorkflowMutation("POST", "/api/v1/workflows")).toEqual({ kind: "create" });
  });

  test("PUT /api/v1/workflows/:id is recognized as update", () => {
    expect(matchWorkflowMutation("PUT", "/api/v1/workflows/abc123")).toEqual({
      kind: "update",
      id: "abc123",
    });
  });

  test("Other endpoints are not matched", () => {
    expect(matchWorkflowMutation("GET", "/api/v1/workflows")).toBeNull();
    expect(matchWorkflowMutation("DELETE", "/api/v1/workflows/abc")).toBeNull();
    expect(matchWorkflowMutation("POST", "/api/v1/credentials")).toBeNull();
    expect(matchWorkflowMutation("POST", "/api/v1/workflows/abc/activate")).toBeNull();
  });

  test("URL-encoded ids are decoded", () => {
    expect(matchWorkflowMutation("PUT", "/api/v1/workflows/wf%20a")).toEqual({
      kind: "update",
      id: "wf a",
    });
  });
});

describe("proxy: transparent forwarding", () => {
  test("GET is forwarded to upstream and response is returned", async () => {
    startWithEnforce("error");
    upstream.respondWith(200, JSON.stringify({ data: ["x"] }));

    const res = await fetch(proxyURL("/api/v1/workflows"), {
      headers: { "x-n8n-api-key": "test-key" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ["x"] });
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]?.method).toBe("GET");
    expect(upstream.captured[0]?.pathname).toBe("/api/v1/workflows");
  });

  test("Auth header X-N8N-API-KEY is forwarded to upstream", async () => {
    startWithEnforce("error");
    await fetch(proxyURL("/api/v1/workflows"), {
      headers: { "x-n8n-api-key": "my-secret-key" },
    });
    expect(upstream.captured[0]?.headers["x-n8n-api-key"]).toBe("my-secret-key");
  });

  test("Healthz is handled locally, never forwarded", async () => {
    startWithEnforce("error");
    const res = await fetch(proxyURL("/healthz"));
    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(0);
  });
});

describe("proxy: workflow create lint enforcement", () => {
  test("clean workflow is forwarded with body intact", async () => {
    startWithEnforce("error");

    const res = await fetch(proxyURL("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: CLEAN_WORKFLOW,
    });

    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]?.method).toBe("POST");
    expect(JSON.parse(upstream.captured[0]?.body ?? "")).toMatchObject({ name: "Clean WF" });
  });

  test("violating workflow is blocked with 422 + violations JSON", async () => {
    startWithEnforce("error");

    const res = await fetch(proxyURL("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: VIOLATING_WORKFLOW,
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      violations: Array<{ rule: string; severity: string }>;
    };
    expect(body.error).toBe("workflow_lint_failed");
    expect(body.violations.some((v) => v.rule === "required-fields")).toBe(true);
    expect(upstream.captured).toHaveLength(0); // upstream never reached
  });

  test("PUT workflow update is intercepted the same way", async () => {
    startWithEnforce("error");

    const res = await fetch(proxyURL("/api/v1/workflows/wf-1"), {
      method: "PUT",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: VIOLATING_WORKFLOW,
    });

    expect(res.status).toBe(422);
    expect(upstream.captured).toHaveLength(0);
  });
});

describe("proxy: enforce modes", () => {
  test("enforce=off forwards even on violations", async () => {
    startWithEnforce("off");

    const res = await fetch(proxyURL("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: VIOLATING_WORKFLOW,
    });

    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
  });

  test("enforce=warn forwards but attaches x-n8n-lint-violations header", async () => {
    startWithEnforce("warn");

    const res = await fetch(proxyURL("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: VIOLATING_WORKFLOW,
    });

    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(res.headers.get("x-n8n-lint-violations")).not.toBeNull();
    const errCount = Number.parseInt(res.headers.get("x-n8n-lint-errors") ?? "0", 10);
    expect(errCount).toBeGreaterThanOrEqual(1);
  });
});

describe("proxy: lint config", () => {
  test("disabled rules via .n8nlintrc.json do not block", async () => {
    const configPath = writeConfig({ "required-fields": "off" });
    startWithEnforce("error", configPath);

    const res = await fetch(proxyURL("/api/v1/workflows"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-n8n-api-key": "k" },
      body: VIOLATING_WORKFLOW,
    });

    expect(res.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
  });
});
