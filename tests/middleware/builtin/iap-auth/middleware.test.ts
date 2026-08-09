import { describe, expect, test } from "bun:test";
import { iapAuthFactory } from "@/middleware/builtin/iap-auth/factory.ts";
import { IapAuthMiddleware } from "@/middleware/builtin/iap-auth/middleware.ts";
import { StaticTokenSource, type TokenSource } from "@/middleware/builtin/iap-auth/token-source.ts";

const baseCtx = {
  request: new Request("http://proxy.local/api/v1/workflows"),
  method: "GET",
  pathname: "/api/v1/workflows",
  upstreamUrl: "http://upstream.local/api/v1/workflows",
};

describe("IapAuthMiddleware", () => {
  test("sets Authorization: Bearer <token>", async () => {
    const mw = new IapAuthMiddleware({
      audience: "aud",
      tokenSource: new StaticTokenSource("tok-1"),
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("authorization")).toBe("Bearer tok-1");
  });

  test("overwrites whatever Authorization already held (default header mode)", async () => {
    const mw = new IapAuthMiddleware({
      audience: "aud",
      tokenSource: new StaticTokenSource("fresh-token"),
    });
    const headers = new Headers({
      authorization: "Bearer client-supplied-token-for-iap-1",
      "x-other": "preserved",
    });
    await mw.apply(headers, baseCtx);
    expect(headers.get("authorization")).toBe("Bearer fresh-token");
    expect(headers.get("x-other")).toBe("preserved");
  });

  test("requests the token using the configured audience", async () => {
    let seenAud: string | undefined;
    const src: TokenSource = {
      getToken(aud) {
        seenAud = aud;
        return Promise.resolve("t");
      },
    };
    const mw = new IapAuthMiddleware({ audience: "https://example.com/iap", tokenSource: src });
    await mw.apply(new Headers(), baseCtx);
    expect(seenAud).toBe("https://example.com/iap");
  });

  test("headerName=proxy-authorization writes there and leaves Authorization alone", async () => {
    const mw = new IapAuthMiddleware({
      audience: "aud",
      tokenSource: new StaticTokenSource("iap-token"),
      headerName: "proxy-authorization",
    });
    // An application-layer token another middleware already placed. IAP reads
    // Proxy-Authorization and forwards this one to the backend unread.
    const headers = new Headers({ authorization: "Bearer app-layer-token" });
    await mw.apply(headers, baseCtx);
    expect(headers.get("proxy-authorization")).toBe("Bearer iap-token");
    expect(headers.get("authorization")).toBe("Bearer app-layer-token");
  });

  test("the default mode leaves Proxy-Authorization alone (regression)", async () => {
    const mw = new IapAuthMiddleware({
      audience: "aud",
      tokenSource: new StaticTokenSource("iap-token"),
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("authorization")).toBe("Bearer iap-token");
    expect(headers.get("proxy-authorization")).toBeNull();
  });

  test("propagates token-source errors", async () => {
    const src: TokenSource = {
      getToken: () => Promise.reject(new Error("metadata down")),
    };
    const mw = new IapAuthMiddleware({ audience: "a", tokenSource: src });
    await expect(mw.apply(new Headers(), baseCtx)).rejects.toThrow(/metadata down/);
  });
});

describe("iapAuthFactory", () => {
  test("rejects when audience missing", () => {
    expect(() => iapAuthFactory.build({})).toThrow();
  });

  test("loads audience and token-env-var from env", () => {
    const partial = iapAuthFactory.loadFromEnv({
      N8N_IAP_AUTH_AUDIENCE: "aud-from-env",
      N8N_IAP_AUTH_TOKEN_SOURCE: "env",
      N8N_IAP_AUTH_TOKEN_ENV_VAR: "MY_TOKEN",
    });
    expect(partial.audience).toBe("aud-from-env");
    expect(partial.tokenSourceKind).toBe("env");
    expect(partial.tokenEnvVar).toBe("MY_TOKEN");
  });

  test("loads from CLI", () => {
    const partial = iapAuthFactory.loadFromCLI({
      iapAuthAudience: "aud-cli",
      iapAuthCacheTtlMs: "60000",
    });
    expect(partial.audience).toBe("aud-cli");
    expect(partial.cacheTtlMs).toBe(60_000);
  });

  test("env source requires tokenEnvVar", () => {
    expect(() => iapAuthFactory.build({ audience: "a", tokenSourceKind: "env" })).toThrow(
      /tokenEnvVar/,
    );
  });

  test("static source requires staticToken", () => {
    expect(() => iapAuthFactory.build({ audience: "a", tokenSourceKind: "static" })).toThrow(
      /staticToken/,
    );
  });

  test("static source builds a middleware that sets the configured token", async () => {
    const mw = iapAuthFactory.build({
      audience: "a",
      tokenSourceKind: "static",
      staticToken: "fixed-token",
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("authorization")).toBe("Bearer fixed-token");
  });

  test("headerName defaults to authorization when nothing configures it", async () => {
    const mw = iapAuthFactory.build({
      audience: "a",
      tokenSourceKind: "static",
      staticToken: "t",
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("authorization")).toBe("Bearer t");
    expect(headers.get("proxy-authorization")).toBeNull();
  });

  test("headerName comes through env, case-insensitively", async () => {
    const partial = iapAuthFactory.loadFromEnv({
      N8N_IAP_AUTH_AUDIENCE: "a",
      N8N_IAP_AUTH_HEADER_NAME: "Proxy-Authorization",
    });
    expect(partial.headerName).toBe("proxy-authorization");
    const mw = iapAuthFactory.build({
      ...partial,
      tokenSourceKind: "static",
      staticToken: "t",
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("proxy-authorization")).toBe("Bearer t");
  });

  test("headerName comes through the CLI", () => {
    const partial = iapAuthFactory.loadFromCLI({
      iapAuthAudience: "a",
      iapAuthHeaderName: "proxy-authorization",
    });
    expect(partial.headerName).toBe("proxy-authorization");
  });

  test("rejects a header name that is neither of the two supported ones", () => {
    expect(
      () =>
        iapAuthFactory.build({
          audience: "a",
          tokenSourceKind: "static",
          staticToken: "t",
          headerName: "x-custom-auth",
        }),
      // The message names the setting, so an operator flipping this one env var
      // learns what to fix without reading the source.
    ).toThrow(/headerName must be authorization or proxy-authorization/);
  });

  test("loadFromEnv picks up impersonation settings", () => {
    const partial = iapAuthFactory.loadFromEnv({
      N8N_IAP_AUTH_AUDIENCE: "a",
      N8N_IAP_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "target@p.iam.gserviceaccount.com",
    });
    expect(partial.impersonateServiceAccount).toBe("target@p.iam.gserviceaccount.com");
  });

  test("loadFromCLI picks up impersonation settings", () => {
    const partial = iapAuthFactory.loadFromCLI({
      iapAuthAudience: "a",
      iapAuthImpersonateServiceAccount: "target@p.iam.gserviceaccount.com",
    });
    expect(partial.impersonateServiceAccount).toBe("target@p.iam.gserviceaccount.com");
  });
});
