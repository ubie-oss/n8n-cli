import { describe, expect, test } from "bun:test";
import { AdcUserTokenSource } from "@/middleware/builtin/impersonator-token/adc-user-token-source.ts";
import { impersonatorTokenFactory } from "@/middleware/builtin/impersonator-token/factory.ts";
import { ImpersonatorTokenMiddleware } from "@/middleware/builtin/impersonator-token/middleware.ts";
import {
  StaticUserTokenSource,
  type UserTokenSource,
} from "@/middleware/builtin/impersonator-token/user-token-source.ts";

const baseCtx = {
  request: new Request("http://proxy.local/api/v1/workflows"),
  method: "GET",
  pathname: "/api/v1/workflows",
  upstreamUrl: "http://upstream.local/api/v1/workflows",
};

describe("ImpersonatorTokenMiddleware", () => {
  test("attaches the token to X-Impersonator-Id-Token by default", async () => {
    const mw = new ImpersonatorTokenMiddleware({
      audience: "aud",
      headerName: "X-Impersonator-Id-Token",
      tokenSource: new StaticUserTokenSource("user-tok"),
      onError: "throw",
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("x-impersonator-id-token")).toBe("user-tok");
  });

  test("respects custom headerName", async () => {
    const mw = new ImpersonatorTokenMiddleware({
      audience: "aud",
      headerName: "X-User-Id-Token",
      tokenSource: new StaticUserTokenSource("t"),
      onError: "throw",
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("x-user-id-token")).toBe("t");
  });

  test("throws on token-source error when onError=throw", async () => {
    const src: UserTokenSource = {
      getToken: () => Promise.reject(new Error("source unavailable")),
    };
    const mw = new ImpersonatorTokenMiddleware({
      audience: "aud",
      headerName: "H",
      tokenSource: src,
      onError: "throw",
    });
    await expect(mw.apply(new Headers(), baseCtx)).rejects.toThrow(/source unavailable/);
  });

  test("swallows error when onError=skip (SA-only fallback)", async () => {
    const src: UserTokenSource = {
      getToken: () => Promise.reject(new Error("source unavailable")),
    };
    const mw = new ImpersonatorTokenMiddleware({
      audience: "aud",
      headerName: "H",
      tokenSource: src,
      onError: "skip",
    });
    const headers = new Headers();
    await mw.apply(headers, baseCtx);
    expect(headers.get("H")).toBeNull();
  });

  test("requests the token using configured audience", async () => {
    let seenAud: string | undefined;
    const src: UserTokenSource = {
      getToken: (aud) => {
        seenAud = aud;
        return Promise.resolve("t");
      },
    };
    const mw = new ImpersonatorTokenMiddleware({
      audience: "https://custom-aud",
      headerName: "H",
      tokenSource: src,
      onError: "throw",
    });
    await mw.apply(new Headers(), baseCtx);
    expect(seenAud).toBe("https://custom-aud");
  });
});

describe("AdcUserTokenSource", () => {
  test("exchanges refresh_token for id_token via the OAuth token endpoint", async () => {
    let capturedBody: string | undefined;
    const src = new AdcUserTokenSource({
      readCredentials: async () => ({
        client_id: "cli",
        client_secret: "secret",
        refresh_token: "rt",
      }),
      fetcher: async (_url, init) => {
        capturedBody = init?.body?.toString();
        return new Response(JSON.stringify({ id_token: "user-id-tok", expires_in: 3600 }), {
          status: 200,
        });
      },
    });
    const token = await src.getToken("aud-x");
    expect(token).toBe("user-id-tok");
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("audience=aud-x");
    expect(capturedBody).toContain("refresh_token=rt");
  });

  test("caches per audience", async () => {
    let calls = 0;
    const src = new AdcUserTokenSource({
      readCredentials: async () => ({
        client_id: "c",
        client_secret: "s",
        refresh_token: "r",
      }),
      fetcher: async () => {
        calls++;
        return new Response(JSON.stringify({ id_token: "t", expires_in: 3600 }), { status: 200 });
      },
    });
    await src.getToken("a");
    await src.getToken("a");
    expect(calls).toBe(1);
  });

  test("throws when ADC file lacks the refresh_token", async () => {
    const src = new AdcUserTokenSource({
      readCredentials: async () => ({ client_id: "c", client_secret: "s" }),
      fetcher: async () => new Response("{}", { status: 200 }),
    });
    await expect(src.getToken("aud")).rejects.toThrow(/refresh_token/);
  });

  test("surfaces non-200 token endpoint responses", async () => {
    const src = new AdcUserTokenSource({
      readCredentials: async () => ({
        client_id: "c",
        client_secret: "s",
        refresh_token: "r",
      }),
      fetcher: async () => new Response("bad_grant", { status: 400 }),
    });
    await expect(src.getToken("aud")).rejects.toThrow(/HTTP 400/);
  });

  test("re-reads credentials after an initial read failure", async () => {
    // Simulates the CLI-user scenario: first call fails because ADC
    // wasn't set up yet, user runs `gcloud auth application-default
    // login`, subsequent call must succeed without restart.
    let attempt = 0;
    const src = new AdcUserTokenSource({
      readCredentials: async () => {
        attempt++;
        if (attempt === 1) throw new Error("ENOENT: application_default_credentials.json");
        return { client_id: "c", client_secret: "s", refresh_token: "r" };
      },
      fetcher: async () =>
        new Response(JSON.stringify({ id_token: "later-tok", expires_in: 3600 }), { status: 200 }),
    });
    await expect(src.getToken("aud")).rejects.toThrow(/ENOENT/);
    // Second call must reach the fetcher — the failed first attempt
    // must NOT be cached.
    const token = await src.getToken("aud");
    expect(token).toBe("later-tok");
    expect(attempt).toBe(2);
  });
});

describe("impersonatorTokenFactory", () => {
  test("audience is optional at build time — the token source may name it", () => {
    // `tokenSourceKind=adc` reads client_id out of the credentials file, and
    // that is the only aud the refresh-token grant can mint for anyway, so
    // requiring the operator to restate it just invites a mismatch.
    expect(() => impersonatorTokenFactory.build({ tokenSourceKind: "adc" })).not.toThrow();
  });

  test("a source that cannot name an audience fails at apply time with a fixable message", async () => {
    const mw = impersonatorTokenFactory.build({
      tokenSourceKind: "static",
      staticToken: "tok",
      onError: "throw",
    });
    await expect(
      mw.apply(new Headers(), { method: "GET", pathname: "/", upstreamUrl: "https://x/" }),
    ).rejects.toThrow(/N8N_IMPERSONATOR_TOKEN_AUDIENCE/);
  });

  test("static token source requires staticToken", () => {
    expect(() =>
      impersonatorTokenFactory.build({ audience: "aud", tokenSourceKind: "static" }),
    ).toThrow(/staticToken/);
  });

  test("env token source requires tokenEnvVar", () => {
    expect(() =>
      impersonatorTokenFactory.build({ audience: "aud", tokenSourceKind: "env" }),
    ).toThrow(/tokenEnvVar/);
  });

  test("default source is env (requires tokenEnvVar to actually build)", () => {
    // Just verifying the default token-source selector doesn't silently
    // pick a Google-specific transport.
    expect(() => impersonatorTokenFactory.build({ audience: "aud" })).toThrow(/tokenEnvVar/);
  });

  test("adc token source is available when explicitly selected", () => {
    const mw = impersonatorTokenFactory.build({ audience: "aud", tokenSourceKind: "adc" });
    expect(mw.name).toBe("impersonator-token");
  });

  test("loads config from env", () => {
    const partial = impersonatorTokenFactory.loadFromEnv({
      N8N_IMPERSONATOR_TOKEN_AUDIENCE: "aud-env",
      N8N_IMPERSONATOR_TOKEN_SOURCE: "env",
      N8N_IMPERSONATOR_TOKEN_ENV_VAR: "MY_USER_TOKEN",
      N8N_IMPERSONATOR_TOKEN_ON_ERROR: "skip",
    });
    expect(partial.audience).toBe("aud-env");
    expect(partial.tokenSourceKind).toBe("env");
    expect(partial.tokenEnvVar).toBe("MY_USER_TOKEN");
    expect(partial.onError).toBe("skip");
  });

  test("loads config from CLI options", () => {
    const partial = impersonatorTokenFactory.loadFromCLI({
      impersonatorTokenAudience: "aud-cli",
      impersonatorTokenOnError: "skip",
    });
    expect(partial.audience).toBe("aud-cli");
    expect(partial.onError).toBe("skip");
  });
});
