import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { impersonatorVerifyFactory } from "@/middleware/builtin/impersonator-verify/factory.ts";
import type { ServerMiddleware, ServerMiddlewareContext } from "@/middleware/types.ts";
import { generateRsaKeys, signJwt, type TestKeys } from "../../auth/jwt-test-keys.ts";

/**
 * The contract a signing platform has to meet, exercised the way
 * production reaches it: environment variables in, a real HTTP JWKS
 * endpoint, a real signature.
 *
 * Everything below is what an integrating platform must get right. If a
 * change here breaks, the platform's minted assertions stop being
 * accepted — so these cases double as the wire spec.
 */

const ISSUER = "signer@example.com";
const AUDIENCE = "example-gateway";
const ASSERTED_USER = "user@example.com";
const TRUSTED_BEARER = "caller@example.com";

let keys: TestKeys;
let otherKeys: TestKeys;
let server: ReturnType<typeof Bun.serve>;
let jwksUri: string;

beforeAll(async () => {
  keys = await generateRsaKeys("k1");
  otherKeys = await generateRsaKeys("k1");
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [keys.publicJwk] }),
  });
  jwksUri = `http://127.0.0.1:${server.port}/jwks`;
});

afterAll(async () => {
  await server.stop(true);
});

function envFor(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    N8N_IMPERSONATOR_VERIFY_ENFORCE: "deny",
    N8N_IMPERSONATOR_VERIFY_REQUIREMENT: "require",
    N8N_IMPERSONATOR_VERIFY_EXPECTED_AUDIENCES: AUDIENCE,
    N8N_IMPERSONATOR_VERIFY_VERIFIERS: "jwks",
    N8N_IMPERSONATOR_VERIFY_JWKS_ISSUERS: `${ISSUER}=${jwksUri}`,
    ...overrides,
  };
}

function buildFromEnv(overrides: Record<string, string> = {}): ServerMiddleware {
  const env = envFor(overrides);
  return impersonatorVerifyFactory.build(impersonatorVerifyFactory.loadFromEnv(env));
}

/** A request that has already cleared a trusted bearer, as oauth-verify leaves it. */
function ctxWith(token: string): ServerMiddlewareContext {
  const headers = new Headers({ "X-Impersonator-Id-Token": token });
  const ctx: ServerMiddlewareContext = {
    workflow: null,
    mode: "proxy",
    request: new Request("https://gateway.local/api/v1/workflows", { headers }),
    identity: TRUSTED_BEARER,
    auth: {
      bearer: { email: TRUSTED_BEARER, aud: "https://gateway.local", verified: true },
      effective: { email: TRUSTED_BEARER, layer: "bearer" },
    },
  };
  (ctx as { __oauthVerifyBearerIsTrusted?: boolean }).__oauthVerifyBearerIsTrusted = true;
  return ctx;
}

function assertion(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: ASSERTED_USER,
    email: ASSERTED_USER,
    email_verified: true,
    aud: AUDIENCE,
    iat: nowSec,
    exp: nowSec + 300,
    ...extra,
  };
}

describe("impersonator-verify wired to jwks from the environment", () => {
  test("accepts a correctly minted assertion and rewrites the identity", async () => {
    const mw = buildFromEnv();
    const ctx = ctxWith(await signJwt(keys, assertion()));

    const verdict = await mw.evaluate(ctx);

    expect(verdict.block).toBe(false);
    // Downstream authz reads this. If it still said the caller, the whole
    // per-user gate would be judging the platform instead of the person.
    expect(ctx.identity).toBe(ASSERTED_USER);
    expect(ctx.auth?.effective).toEqual({ email: ASSERTED_USER, layer: "impersonator" });
    expect(ctx.auth?.impersonator?.email).toBe(ASSERTED_USER);
  });

  test("rejects an assertion signed by a key the issuer does not publish", async () => {
    const mw = buildFromEnv();
    const ctx = ctxWith(await signJwt(otherKeys, assertion()));

    const verdict = await mw.evaluate(ctx);

    expect(verdict.block).toBe(true);
    expect(verdict.denial?.status).toBe(401);
    expect(ctx.identity).toBe(TRUSTED_BEARER);
  });

  test("rejects an assertion from an issuer that is not configured", async () => {
    const mw = buildFromEnv();
    const ctx = ctxWith(await signJwt(keys, assertion({ iss: "rogue@example.com" })));

    expect((await mw.evaluate(ctx)).block).toBe(true);
  });

  test("rejects an assertion minted for a different audience", async () => {
    const mw = buildFromEnv();
    const ctx = ctxWith(await signJwt(keys, assertion({ aud: "some-other-gateway" })));

    expect((await mw.evaluate(ctx)).block).toBe(true);
  });

  test("rejects an expired assertion", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mw = buildFromEnv();
    const ctx = ctxWith(await signJwt(keys, assertion({ exp: nowSec - 3600 })));

    expect((await mw.evaluate(ctx)).block).toBe(true);
  });

  test("rejects a valid assertion when the bearer is not trusted to forward one", async () => {
    const mw = buildFromEnv();
    const ctx = ctxWith(await signJwt(keys, assertion()));
    (ctx as { __oauthVerifyBearerIsTrusted?: boolean }).__oauthVerifyBearerIsTrusted = false;

    // The signature is genuine; the relay is not authorized. Both gates
    // have to hold, otherwise anyone who can reach the gateway could
    // replay a leaked assertion.
    expect((await mw.evaluate(ctx)).block).toBe(true);
  });

  test("honors a non-email identity claim with the verified-claim check cleared", async () => {
    const mw = buildFromEnv({
      N8N_IMPERSONATOR_VERIFY_IDENTITY_CLAIM: "actor",
      N8N_IMPERSONATOR_VERIFY_EMAIL_VERIFIED_CLAIM: "",
    });
    const { email: _e, email_verified: _v, ...rest } = assertion();
    const ctx = ctxWith(await signJwt(keys, { ...rest, actor: "octocat" }));

    expect((await mw.evaluate(ctx)).block).toBe(false);
    expect(ctx.identity).toBe("octocat");
  });

  test("keeps accepting jwks assertions when chained behind another verifier", async () => {
    const mw = buildFromEnv({ N8N_IMPERSONATOR_VERIFY_VERIFIERS: "jwks,google-tokeninfo" });
    const ctx = ctxWith(await signJwt(keys, assertion()));

    // Listing jwks first means the platform's own assertion never costs a
    // round trip to a foreign issuer's endpoint.
    expect((await mw.evaluate(ctx)).block).toBe(false);
    expect(ctx.identity).toBe(ASSERTED_USER);
  });
});

describe("impersonator-verify configuration errors surface at startup", () => {
  test("refuses to build a jwks verifier with no issuers", () => {
    expect(() =>
      impersonatorVerifyFactory.build(
        impersonatorVerifyFactory.loadFromEnv({
          N8N_IMPERSONATOR_VERIFY_VERIFIERS: "jwks",
        }),
      ),
    ).toThrow(/no issuers are configured/);
  });

  test("refuses a malformed issuer mapping", () => {
    expect(() =>
      impersonatorVerifyFactory.loadFromEnv({
        N8N_IMPERSONATOR_VERIFY_JWKS_ISSUERS: "missing-the-url",
      }),
    ).toThrow(/expected "<issuer>=<jwks-url>"/);
  });

  test("refuses an unknown verifier name", () => {
    expect(() =>
      impersonatorVerifyFactory.build(
        impersonatorVerifyFactory.loadFromEnv({
          N8N_IMPERSONATOR_VERIFY_VERIFIERS: "totally-made-up",
        }),
      ),
    ).toThrow();
  });
});

describe("impersonator-verify env parsing", () => {
  test("splits the issuer mapping on the first separator only", () => {
    const partial = impersonatorVerifyFactory.loadFromEnv({
      N8N_IMPERSONATOR_VERIFY_JWKS_ISSUERS:
        "https://issuer.example.com=https://keys.example.com/jwks?v=2",
    });
    expect(partial.jwksIssuers).toEqual([
      { issuer: "https://issuer.example.com", jwksUri: "https://keys.example.com/jwks?v=2" },
    ]);
  });

  test("reads multiple issuers", () => {
    const partial = impersonatorVerifyFactory.loadFromEnv({
      N8N_IMPERSONATOR_VERIFY_JWKS_ISSUERS:
        "a@example.com=https://a/jwks,b@example.com=https://b/jwks",
    });
    expect(partial.jwksIssuers).toHaveLength(2);
  });

  test("treats an empty verified-claim as an explicit opt-out, not as unset", () => {
    const partial = impersonatorVerifyFactory.loadFromEnv({
      N8N_IMPERSONATOR_VERIFY_EMAIL_VERIFIED_CLAIM: "",
    });
    expect(partial.emailVerifiedClaim).toBe("");
  });

  test("defaults to the Google verifier when nothing is configured", () => {
    const partial = impersonatorVerifyFactory.loadFromEnv({});
    expect(partial.verifiers).toBeUndefined();
    // Building with no overrides must not throw, i.e. the default path is
    // unchanged for deployments that never heard of jwks.
    expect(() => impersonatorVerifyFactory.build(partial)).not.toThrow();
  });
});
