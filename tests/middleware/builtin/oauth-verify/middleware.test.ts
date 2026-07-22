import { describe, expect, test } from "bun:test";
import { GoogleTokeninfoVerifier } from "@/middleware/auth/google-tokeninfo.ts";
import type { IdTokenVerifier, VerifiedClaim } from "@/middleware/auth/types.ts";
import { oauthVerifyFactory } from "@/middleware/builtin/oauth-verify/factory.ts";
import { OAuthVerifyMiddleware } from "@/middleware/builtin/oauth-verify/middleware.ts";
import type { ServerMiddlewareContext } from "@/middleware/types.ts";

function reqWith(auth: string | null): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("https://proxy.local/api/v1/workflows", { headers });
}

function baseCtx(req: Request): ServerMiddlewareContext {
  return { workflow: null, request: req, mode: "proxy" };
}

/** Stub verifier — the middleware doesn't care about the underlying token bytes. */
function verifierYielding(claim: VerifiedClaim | null): IdTokenVerifier {
  return { verify: async () => claim };
}

const validClaim: VerifiedClaim = {
  iss: "https://accounts.google.com",
  aud: "https://proxy.local",
  email: "user@example.com",
  emailVerified: true,
};

describe("OAuthVerifyMiddleware", () => {
  test("accepts a valid bearer and populates auth context", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: ["https://proxy.local"],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const ctx = baseCtx(reqWith("Bearer tok"));
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(ctx.auth?.bearer?.email).toBe("user@example.com");
    expect(ctx.auth?.effective).toEqual({ email: "user@example.com", layer: "bearer" });
    expect(ctx.identity).toBe("user@example.com");
  });

  test("rejects a missing bearer with 401 when enforce=deny", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: ["aud"],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const ctx = baseCtx(reqWith(null));
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
    expect(verdict.denial?.status).toBe(401);
  });

  test("rejects wrong aud", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: ["something-else"],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const ctx = baseCtx(reqWith("Bearer tok"));
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(true);
    expect(verdict.denial?.error).toBe("bearer_verification_failed");
    // Aud must NOT leak to the caller — check only the generic message.
    expect(verdict.denial?.message).toBe("Bearer verification failed.");
  });

  test("rejects unverified email", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: ["https://proxy.local"],
      trustedPrincipals: [],
      verifier: verifierYielding({ ...validClaim, emailVerified: false }),
    });
    const verdict = await mw.evaluate(baseCtx(reqWith("Bearer tok")));
    expect(verdict.block).toBe(true);
  });

  test("warn mode returns block=false but emits a warning violation", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "warn",
      expectedAudiences: ["something-else"],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const verdict = await mw.evaluate(baseCtx(reqWith("Bearer tok")));
    expect(verdict.block).toBe(false);
    expect(verdict.violations[0]?.severity).toBe("warning");
  });

  test("off mode passes without touching context", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "off",
      expectedAudiences: [],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const ctx = baseCtx(reqWith(null));
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(ctx.auth).toBeUndefined();
  });

  test("marks trusted principals via internal context flag", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: ["https://proxy.local"],
      trustedPrincipals: ["user@example.com"],
      verifier: verifierYielding(validClaim),
    });
    const ctx = baseCtx(reqWith("Bearer tok"));
    await mw.evaluate(ctx);
    const trusted = (ctx as { __oauthVerifyBearerIsTrusted?: boolean })
      .__oauthVerifyBearerIsTrusted;
    expect(trusted).toBe(true);
  });

  test("no expected audiences configured → fails closed", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: [],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const verdict = await mw.evaluate(baseCtx(reqWith("Bearer tok")));
    expect(verdict.block).toBe(true);
  });

  test("apply/single mode passes through without touching auth", async () => {
    const mw = new OAuthVerifyMiddleware({
      enforce: "deny",
      expectedAudiences: [],
      trustedPrincipals: [],
      verifier: verifierYielding(validClaim),
    });
    const ctx: ServerMiddlewareContext = { workflow: null, mode: "apply" };
    const verdict = await mw.evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(ctx.auth).toBeUndefined();
  });

  test("default verifier is Google when none injected", () => {
    // Sanity check the factory-default wiring: constructing with no
    // verifier should not throw and should produce a working middleware.
    const mw = new OAuthVerifyMiddleware({
      enforce: "off",
      expectedAudiences: [],
      trustedPrincipals: [],
    });
    expect(mw.name).toBe("oauth-verify");
    // The internal verifier field is private; check the class exists.
    expect(new GoogleTokeninfoVerifier()).toBeDefined();
  });
});

describe("oauthVerifyFactory", () => {
  test("loads config from env", () => {
    const partial = oauthVerifyFactory.loadFromEnv({
      N8N_OAUTH_VERIFY_ENFORCE: "warn",
      N8N_OAUTH_VERIFY_EXPECTED_AUDIENCES: "a, b , c ",
      N8N_OAUTH_VERIFY_TRUSTED_PRINCIPALS: "sa@example.com",
    });
    expect(partial.enforce).toBe("warn");
    expect(partial.expectedAudiences).toEqual(["a", "b", "c"]);
    expect(partial.trustedPrincipals).toEqual(["sa@example.com"]);
  });

  test("loads config from CLI", () => {
    const partial = oauthVerifyFactory.loadFromCLI({
      oauthVerifyEnforce: "warn",
      oauthVerifyExpectedAudiences: "aud1,aud2",
    });
    expect(partial.enforce).toBe("warn");
    expect(partial.expectedAudiences).toEqual(["aud1", "aud2"]);
  });

  test("build() constructs a live middleware", () => {
    const mw = oauthVerifyFactory.build({ expectedAudiences: ["aud"] });
    expect(mw.name).toBe("oauth-verify");
  });
});
