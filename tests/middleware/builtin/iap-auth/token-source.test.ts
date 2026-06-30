import { describe, expect, test } from "bun:test";
import {
  EnvTokenSource,
  type FetchLike,
  MetadataServerTokenSource,
  StaticTokenSource,
} from "@/middleware/builtin/iap-auth/token-source.ts";

function tokenResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("MetadataServerTokenSource", () => {
  test("fetches once and caches subsequent calls for the same audience", async () => {
    let hits = 0;
    const fetcher: FetchLike = (url) => {
      hits++;
      expect(url).toContain("audience=https%3A%2F%2Fexample.com");
      return Promise.resolve(tokenResponse("token-1"));
    };
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0, cacheTtlMs: 1_000_000 });
    expect(await src.getToken("https://example.com")).toBe("token-1");
    expect(await src.getToken("https://example.com")).toBe("token-1");
    expect(hits).toBe(1);
  });

  test("refetches once cached entry expires", async () => {
    let hits = 0;
    let nowMs = 0;
    const fetcher: FetchLike = () => {
      hits++;
      return Promise.resolve(tokenResponse(`token-${hits}`));
    };
    const src = new MetadataServerTokenSource({
      fetcher,
      now: () => nowMs,
      cacheTtlMs: 1000,
    });
    expect(await src.getToken("aud")).toBe("token-1");
    nowMs = 1500;
    expect(await src.getToken("aud")).toBe("token-2");
    expect(hits).toBe(2);
  });

  test("caches per audience independently", async () => {
    let hits = 0;
    const fetcher: FetchLike = (url) => {
      hits++;
      const u = new URL(url);
      return Promise.resolve(tokenResponse(`tk-${u.searchParams.get("audience")}`));
    };
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0, cacheTtlMs: 1_000_000 });
    expect(await src.getToken("a")).toBe("tk-a");
    expect(await src.getToken("b")).toBe("tk-b");
    expect(await src.getToken("a")).toBe("tk-a");
    expect(hits).toBe(2);
  });

  test("coalesces concurrent misses for the same audience into one fetch", async () => {
    let hits = 0;
    const fetcher: FetchLike = () => {
      hits++;
      return new Promise((resolve) => {
        setTimeout(() => resolve(tokenResponse("token-coal")), 5);
      });
    };
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0, cacheTtlMs: 1_000_000 });
    const [a, b, c] = await Promise.all([src.getToken("x"), src.getToken("x"), src.getToken("x")]);
    expect(a).toBe("token-coal");
    expect(b).toBe("token-coal");
    expect(c).toBe("token-coal");
    expect(hits).toBe(1);
  });

  test("rejects with a clear message on non-200 metadata response", async () => {
    const fetcher: FetchLike = () => Promise.resolve(tokenResponse("forbidden", 403));
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0 });
    await expect(src.getToken("aud")).rejects.toThrow(/HTTP 403/);
  });

  test("rejects on empty token body", async () => {
    const fetcher: FetchLike = () => Promise.resolve(tokenResponse("   "));
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0 });
    await expect(src.getToken("aud")).rejects.toThrow(/empty/);
  });

  test("sends Metadata-Flavor: Google header", async () => {
    let captured: Headers | undefined;
    const fetcher: FetchLike = (_url, init) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(tokenResponse("ok"));
    };
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0 });
    await src.getToken("aud");
    expect(captured?.get("Metadata-Flavor")).toBe("Google");
  });
});

describe("MetadataServerTokenSource impersonation", () => {
  function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("uses iamcredentials API and forwards the caller's access_token", async () => {
    const calls: Array<{ url: string; method: string; auth?: string; body?: string }> = [];
    const fetcher: FetchLike = async (url, init) => {
      const u = String(url);
      const h = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url: u, method: init?.method ?? "GET", auth: h.get("authorization") ?? undefined, body });
      if (u.endsWith("/token")) {
        return jsonResponse({ access_token: "caller-at", expires_in: 3600 });
      }
      if (u.includes(":generateIdToken")) {
        return jsonResponse({ token: "impersonated-id-token" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const src = new MetadataServerTokenSource({
      fetcher,
      now: () => 0,
      impersonateServiceAccount: "target-sa@proj.iam.gserviceaccount.com",
      iamCredentialsBaseUrl: "https://iam.fake",
    });
    const token = await src.getToken("https://example.com/iap");
    expect(token).toBe("impersonated-id-token");
    // Two calls: 1) get access_token, 2) call generateIdToken with it.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/instance/service-accounts/default/token");
    expect(calls[1]!.url).toBe(
      "https://iam.fake/projects/-/serviceAccounts/target-sa%40proj.iam.gserviceaccount.com:generateIdToken",
    );
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.auth).toBe("Bearer caller-at");
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      audience: "https://example.com/iap",
      includeEmail: false,
    });
  });

  test("caches the caller's access_token across multiple impersonation calls", async () => {
    let atHits = 0;
    let idtHits = 0;
    const fetcher: FetchLike = async (url) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        atHits++;
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes(":generateIdToken")) {
        idtHits++;
        const audMatch = u; // just count
        void audMatch;
        return new Response(JSON.stringify({ token: `idt-${idtHits}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const src = new MetadataServerTokenSource({
      fetcher,
      now: () => 0,
      cacheTtlMs: 0, // force id_token refetch
      impersonateServiceAccount: "target@p.iam",
      iamCredentialsBaseUrl: "https://iam.fake",
    });
    await src.getToken("a");
    await src.getToken("b");
    expect(atHits).toBe(1); // access_token cached
    expect(idtHits).toBe(2); // id_token refetched per call (TTL=0)
  });

  test("403 from iamcredentials propagates with a clear message", async () => {
    const fetcher: FetchLike = async (url) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("missing serviceAccountTokenCreator", {
        status: 403,
        headers: { "content-type": "text/plain" },
      });
    };
    const src = new MetadataServerTokenSource({
      fetcher,
      now: () => 0,
      impersonateServiceAccount: "target@p.iam",
      iamCredentialsBaseUrl: "https://iam.fake",
    });
    await expect(src.getToken("aud")).rejects.toThrow(
      /generateIdToken for target@p\.iam returned HTTP 403/,
    );
  });

  test("when not impersonating, never touches iamcredentials", async () => {
    let iamHit = 0;
    const fetcher: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes(":generateIdToken")) {
        iamHit++;
        return new Response("nope", { status: 500 });
      }
      // Direct metadata path uses /identity, not /token.
      if (u.includes("/identity")) {
        return new Response("direct-id-token", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
    const src = new MetadataServerTokenSource({ fetcher, now: () => 0 });
    expect(await src.getToken("aud")).toBe("direct-id-token");
    expect(iamHit).toBe(0);
  });
});

describe("StaticTokenSource", () => {
  test("returns the configured token", async () => {
    const src = new StaticTokenSource("static-tok");
    expect(await src.getToken("anything")).toBe("static-tok");
  });
});

describe("EnvTokenSource", () => {
  test("reads from the named env var", async () => {
    const src = new EnvTokenSource("FAKE_IAP_TOKEN", { FAKE_IAP_TOKEN: "env-tok" });
    expect(await src.getToken("aud")).toBe("env-tok");
  });

  test("rejects when env var is unset", async () => {
    const src = new EnvTokenSource("MISSING", {});
    await expect(src.getToken("aud")).rejects.toThrow(/not set or empty/);
  });

  test("re-reads on every call (rotation works)", async () => {
    const env: NodeJS.ProcessEnv = { TOK: "first" };
    const src = new EnvTokenSource("TOK", env);
    expect(await src.getToken("aud")).toBe("first");
    env.TOK = "second";
    expect(await src.getToken("aud")).toBe("second");
  });
});
