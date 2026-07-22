import { describe, expect, test } from "bun:test";
import type { IdTokenVerifier, VerifiedClaim } from "@/middleware/auth/types.ts";
import { impersonatorVerifyFactory } from "@/middleware/builtin/impersonator-verify/factory.ts";
import { ImpersonatorVerifyMiddleware } from "@/middleware/builtin/impersonator-verify/middleware.ts";
import type { ServerMiddlewareContext, VerifiedTokenClaim } from "@/middleware/types.ts";

const OAUTH_CLIENT_AUD = "example-oauth-client.apps.example.com";

function reqWithHeader(name: string, value: string | null): Request {
  const headers = new Headers();
  if (value) headers.set(name, value);
  return new Request("https://proxy.local/api/v1/workflows", { headers });
}

function baseCtx(
  req: Request,
  opts?: { trustedBearer?: boolean; bearer?: VerifiedTokenClaim },
): ServerMiddlewareContext {
  const ctx: ServerMiddlewareContext = { workflow: null, request: req, mode: "proxy" };
  if (opts?.bearer) {
    ctx.auth = { bearer: opts.bearer, effective: { email: opts.bearer.email, layer: "bearer" } };
    ctx.identity = opts.bearer.email;
  }
  if (opts?.trustedBearer !== undefined) {
    (ctx as { __oauthVerifyBearerIsTrusted?: boolean }).__oauthVerifyBearerIsTrusted =
      opts.trustedBearer;
  }
  return ctx;
}

function verifierYielding(claim: VerifiedClaim | null): IdTokenVerifier {
  return { verify: async () => claim };
}

const validUserClaim: VerifiedClaim = {
  iss: "https://accounts.google.com",
  aud: OAUTH_CLIENT_AUD,
  email: "user@example.com",
  emailVerified: true,
};

const trustedBearerPrincipal: VerifiedTokenClaim = {
  email: "trusted-caller@example.com",
  aud: "https://proxy.local",
  verified: true,
};

describe("ImpersonatorVerifyMiddleware", () => {
  test("accepts a valid impersonator when bearer principal is trusted", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding(validUserClaim),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", "user-tok"), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(ctx.auth?.impersonator?.email).toBe("user@example.com");
    expect(ctx.auth?.effective).toEqual({ email: "user@example.com", layer: "impersonator" });
    expect(ctx.identity).toBe("user@example.com");
  });

  test("rejects impersonator when bearer principal is untrusted", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding(validUserClaim),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", "user-tok"), {
      trustedBearer: false,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
    expect(verdict.denial?.status).toBe(401);
  });

  test("rejects impersonator when bearer not verified upstream", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding(validUserClaim),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", "user-tok"));
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
  });

  test("passes silently when no impersonator header (requirement=optional)", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding(validUserClaim),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", null), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(ctx.auth?.impersonator).toBeUndefined();
    expect(ctx.auth?.effective?.layer).toBe("bearer");
  });

  test("blocks when no impersonator header + requirement=require", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "require",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding(validUserClaim),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", null), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
  });

  test("rejects wrong-aud impersonator", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding({ ...validUserClaim, aud: "https://wrong" }),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", "user-tok"), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
    // Aud must NOT leak to the caller.
    expect(verdict.denial?.message).toBe("Impersonator verification failed.");
  });

  test("rejects unverified-email impersonator", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding({ ...validUserClaim, emailVerified: false }),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", "user-tok"), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
  });

  test("warn mode emits a violation but does not block", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "warn",
      requirement: "optional",
      headerName: "X-Impersonator-Id-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding({ ...validUserClaim, aud: "wrong" }),
    });
    const ctx = baseCtx(reqWithHeader("X-Impersonator-Id-Token", "user-tok"), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(verdict.violations[0]?.severity).toBe("warning");
  });

  test("respects a custom header name", async () => {
    const mw = new ImpersonatorVerifyMiddleware({
      enforce: "deny",
      requirement: "optional",
      headerName: "X-Custom-User-Token",
      expectedAudiences: [OAUTH_CLIENT_AUD],
      verifier: verifierYielding(validUserClaim),
    });
    const ctx = baseCtx(reqWithHeader("X-Custom-User-Token", "user-tok"), {
      trustedBearer: true,
      bearer: trustedBearerPrincipal,
    });
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(ctx.auth?.impersonator?.email).toBe("user@example.com");
  });
});

describe("impersonatorVerifyFactory", () => {
  test("loads from env with sensible defaults", () => {
    const partial = impersonatorVerifyFactory.loadFromEnv({
      N8N_IMPERSONATOR_VERIFY_ENFORCE: "warn",
      N8N_IMPERSONATOR_VERIFY_REQUIREMENT: "require",
      N8N_IMPERSONATOR_VERIFY_EXPECTED_AUDIENCES: "aud-a,aud-b",
    });
    expect(partial.enforce).toBe("warn");
    expect(partial.requirement).toBe("require");
    expect(partial.expectedAudiences).toEqual(["aud-a", "aud-b"]);
  });
});
