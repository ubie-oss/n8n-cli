import { describe, expect, test } from "bun:test";
import { CompositeVerifier, type FetchLike, JwksVerifier } from "@/middleware/auth/jwks.ts";
import type { IdTokenVerifier, VerifiedClaim } from "@/middleware/auth/types.ts";
import {
  b64url,
  encodeSegment,
  generateEcKeys as generateEc,
  generateRsaKeys as generateRsa,
  signJwt as sign,
} from "./jwt-test-keys.ts";

/**
 * These tests sign with real keys rather than stubbing the crypto. A
 * verifier that is only ever handed tokens a mock declared valid proves
 * nothing about whether it would accept a forged one.
 */

const ISSUER = "signer@example.com";
const JWKS_URI = "https://keys.example.com/jwks";
const AUDIENCE = "example-gateway";

/** Claims a well-behaved issuer emits. `now` is fixed so tests are stable. */
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "user@example.com",
    email: "user@example.com",
    email_verified: true,
    aud: AUDIENCE,
    iat: NOW_SEC,
    exp: NOW_SEC + 300,
    ...extra,
  };
}

/** JWKS endpoint stub that counts how many times it was hit. */
function jwksEndpoint(jwks: Array<Record<string, unknown>>) {
  const state = { calls: 0, keys: jwks };
  const fetcher: FetchLike = async (url) => {
    state.calls++;
    if (url !== JWKS_URI) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
  };
  return { fetcher, state };
}

function verifierFor(
  fetcher: FetchLike,
  opts: Partial<ConstructorParameters<typeof JwksVerifier>[0]> = {},
): JwksVerifier {
  return new JwksVerifier({
    issuers: [{ issuer: ISSUER, jwksUri: JWKS_URI }],
    fetcher,
    now: () => NOW_MS,
    ...opts,
  });
}

describe("JwksVerifier: accepts what the listed issuer signed", () => {
  test("verifies an RS256 assertion and surfaces its claims", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const verified = await verifierFor(fetcher).verify(await sign(keys, claims()));

    expect(verified).not.toBeNull();
    expect(verified?.email).toBe("user@example.com");
    expect(verified?.emailVerified).toBe(true);
    expect(verified?.aud).toBe(AUDIENCE);
    expect(verified?.iss).toBe(ISSUER);
    expect(verified?.sub).toBe("user@example.com");
    expect(verified?.exp).toBe(NOW_SEC + 300);
  });

  test("verifies an ES256 assertion", async () => {
    const keys = await generateEc("e1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims(), { alg: "ES256" });

    expect(await verifierFor(fetcher).verify(token)).not.toBeNull();
  });

  test("accepts a single-element array audience", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ aud: [AUDIENCE] }));

    expect((await verifierFor(fetcher).verify(token))?.aud).toBe(AUDIENCE);
  });

  test("accepts a key published without a kid when it is the only one", async () => {
    const keys = await generateRsa("unused");
    const { kid: _kid, ...noKid } = keys.publicJwk;
    const { fetcher } = jwksEndpoint([noKid]);
    const token = await sign(keys, claims(), { header: { kid: undefined } });

    expect(await verifierFor(fetcher).verify(token)).not.toBeNull();
  });
});

describe("JwksVerifier: rejects forgeries", () => {
  test("rejects a token whose signature was tampered with", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims());
    const [h, p] = token.split(".");
    const forged = `${h}.${p}.${b64url(new Uint8Array(256))}`;

    expect(await verifierFor(fetcher).verify(forged)).toBeNull();
  });

  test("rejects a payload edited after signing", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims());
    const [h, , s] = token.split(".");
    const swapped = `${h}.${encodeSegment(claims({ email: "attacker@example.com" }))}.${s}`;

    expect(await verifierFor(fetcher).verify(swapped)).toBeNull();
  });

  test("rejects a token signed by a key the issuer does not publish", async () => {
    const published = await generateRsa("k1");
    const attacker = await generateRsa("k1"); // same kid, different key
    const { fetcher } = jwksEndpoint([published.publicJwk]);

    expect(await verifierFor(fetcher).verify(await sign(attacker, claims()))).toBeNull();
  });

  test("rejects alg=none", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const header = { alg: "none", kid: "k1", typ: "JWT" };
    const unsigned = `${encodeSegment(header)}.${encodeSegment(claims())}.`;

    expect(await verifierFor(fetcher).verify(unsigned)).toBeNull();
  });

  test("rejects an HMAC alg even when the header claims the published kid", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const header = { alg: "HS256", kid: "k1", typ: "JWT" };
    const token = `${encodeSegment(header)}.${encodeSegment(claims())}.${b64url(new Uint8Array(32))}`;

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });

  test("rejects an RS256 header pointing at an EC key", async () => {
    const ec = await generateEc("k1");
    const rsa = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([ec.publicJwk]);

    expect(await verifierFor(fetcher).verify(await sign(rsa, claims()))).toBeNull();
  });

  test("rejects malformed tokens", async () => {
    const { fetcher } = jwksEndpoint([]);
    const verifier = verifierFor(fetcher);

    expect(await verifier.verify("")).toBeNull();
    expect(await verifier.verify("not-a-jwt")).toBeNull();
    expect(await verifier.verify("only.two")).toBeNull();
    expect(await verifier.verify("bm90LWpzb24.bm90LWpzb24.c2ln")).toBeNull();
  });

  test("rejects an unknown kid without letting it hammer the issuer", async () => {
    const keys = await generateRsa("k1");
    const { fetcher, state } = jwksEndpoint([keys.publicJwk]);
    const verifier = verifierFor(fetcher);
    const token = await sign(keys, claims(), { header: { kid: "nope" } });

    expect(await verifier.verify(token)).toBeNull();
    expect(await verifier.verify(token)).toBeNull();
    // One fetch for the cold cache; the second lookup is inside the
    // refetch floor and must not reach the network again.
    expect(state.calls).toBe(1);
  });

  test("rejects when the key set cannot be fetched", async () => {
    const keys = await generateRsa("k1");
    const failing: FetchLike = async () => new Response("boom", { status: 500 });

    expect(await verifierFor(failing).verify(await sign(keys, claims()))).toBeNull();
  });

  test("rejects when no kid is present and the issuer publishes several keys", async () => {
    const a = await generateRsa("a");
    const b = await generateRsa("b");
    const { fetcher } = jwksEndpoint([a.publicJwk, b.publicJwk]);
    const token = await sign(a, claims(), { header: { kid: undefined } });

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });
});

describe("JwksVerifier: issuer allowlist is the trust boundary", () => {
  test("rejects an unlisted issuer", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ iss: "other@example.com" }));

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });

  test("rejects an unlisted issuer without any network call", async () => {
    const keys = await generateRsa("k1");
    const { fetcher, state } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ iss: "other@example.com" }));

    await verifierFor(fetcher).verify(token);
    // This is what makes the verifier safe to place first in a chain: a
    // token that was never ours costs nothing to decline.
    expect(state.calls).toBe(0);
  });

  test("rejects everything when no issuer is configured", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const verifier = verifierFor(fetcher, { issuers: [] });

    expect(await verifier.verify(await sign(keys, claims()))).toBeNull();
  });
});

describe("JwksVerifier: time window", () => {
  test("rejects an expired token", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ exp: NOW_SEC - 120 }));

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });

  test("tolerates expiry inside the configured skew", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ exp: NOW_SEC - 30 }));

    expect(await verifierFor(fetcher, { clockSkewSec: 60 }).verify(token)).not.toBeNull();
  });

  test("rejects a token with no expiry at all", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const { exp: _exp, ...noExp } = claims();

    expect(await verifierFor(fetcher).verify(await sign(keys, noExp))).toBeNull();
  });

  test("rejects a token that is not valid yet", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ nbf: NOW_SEC + 600 }));

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });

  test("rejects a token issued far in the future", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ iat: NOW_SEC + 600, exp: NOW_SEC + 900 }));

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });
});

describe("JwksVerifier: claim policy is configurable", () => {
  test("rejects a multi-valued audience rather than picking one", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const token = await sign(keys, claims({ aud: [AUDIENCE, "other"] }));

    expect(await verifierFor(fetcher).verify(token)).toBeNull();
  });

  test("rejects when the email_verified convention is not honored", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);

    expect(
      await verifierFor(fetcher).verify(await sign(keys, claims({ email_verified: false }))),
    ).toBeNull();
    const { email_verified: _ev, ...missing } = claims();
    expect(await verifierFor(fetcher).verify(await sign(keys, missing))).toBeNull();
  });

  test("skips the email_verified check when the claim name is cleared", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const { email_verified: _ev, ...missing } = claims();
    const verifier = verifierFor(fetcher, { emailVerifiedClaim: "" });

    expect(await verifier.verify(await sign(keys, missing))).not.toBeNull();
  });

  test("reads the identity from a configured claim", async () => {
    // The shape a CI OIDC token takes: a username, no email anywhere.
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const { email: _e, email_verified: _ev, ...ci } = claims();
    const token = await sign(keys, { ...ci, actor: "octocat" });
    const verifier = verifierFor(fetcher, { identityClaim: "actor", emailVerifiedClaim: "" });

    expect((await verifier.verify(token))?.email).toBe("octocat");
  });

  test("rejects when the identity claim is absent or not a string", async () => {
    const keys = await generateRsa("k1");
    const { fetcher } = jwksEndpoint([keys.publicJwk]);
    const { email: _e, ...noEmail } = claims();

    expect(await verifierFor(fetcher).verify(await sign(keys, noEmail))).toBeNull();
    expect(await verifierFor(fetcher).verify(await sign(keys, claims({ email: 42 })))).toBeNull();
  });
});

describe("JwksVerifier: key set handling", () => {
  test("caches the key set across verifications", async () => {
    const keys = await generateRsa("k1");
    const { fetcher, state } = jwksEndpoint([keys.publicJwk]);
    const verifier = verifierFor(fetcher);

    await verifier.verify(await sign(keys, claims()));
    await verifier.verify(await sign(keys, claims()));

    expect(state.calls).toBe(1);
  });

  test("collapses concurrent cold lookups into one fetch", async () => {
    const keys = await generateRsa("k1");
    const { fetcher, state } = jwksEndpoint([keys.publicJwk]);
    const verifier = verifierFor(fetcher);
    const token = await sign(keys, claims());

    const results = await Promise.all([verifier.verify(token), verifier.verify(token)]);

    expect(results.every((r) => r !== null)).toBe(true);
    expect(state.calls).toBe(1);
  });

  test("picks up a rotated key once the refetch floor has passed", async () => {
    const oldKeys = await generateRsa("old");
    const newKeys = await generateRsa("new");
    const { fetcher, state } = jwksEndpoint([oldKeys.publicJwk]);
    let clock = NOW_MS;
    const verifier = verifierFor(fetcher, {
      now: () => clock,
      // Long TTL so the refetch is attributable to the unknown kid alone.
      jwksCacheTtlMs: 60 * 60 * 1000,
      jwksMinRefetchMs: 30_000,
    });

    await verifier.verify(await sign(oldKeys, claims()));
    expect(state.calls).toBe(1);

    state.keys = [newKeys.publicJwk];
    clock += 60_000;

    expect(await verifier.verify(await sign(newKeys, claims()))).not.toBeNull();
    expect(state.calls).toBe(2);
  });

  test("refetches after the cache TTL expires", async () => {
    const keys = await generateRsa("k1");
    const { fetcher, state } = jwksEndpoint([keys.publicJwk]);
    let clock = NOW_MS;
    const verifier = verifierFor(fetcher, { now: () => clock, jwksCacheTtlMs: 1_000 });

    await verifier.verify(await sign(keys, claims()));
    clock += 5_000;
    await verifier.verify(await sign(keys, claims()));

    expect(state.calls).toBe(2);
  });
});

describe("CompositeVerifier", () => {
  const accept: VerifiedClaim = { aud: "a", emailVerified: true, email: "a@example.com" };

  function counting(result: VerifiedClaim | null) {
    const state = { calls: 0 };
    const verifier: IdTokenVerifier = {
      verify: async () => {
        state.calls++;
        return result;
      },
    };
    return { verifier, state };
  }

  test("returns the first acceptance and stops there", async () => {
    const first = counting(accept);
    const second = counting(accept);

    const claim = await new CompositeVerifier([first.verifier, second.verifier]).verify("t");

    expect(claim).toEqual(accept);
    expect(second.state.calls).toBe(0);
  });

  test("falls through to the next verifier on rejection", async () => {
    const first = counting(null);
    const second = counting(accept);

    const claim = await new CompositeVerifier([first.verifier, second.verifier]).verify("t");

    expect(claim).toEqual(accept);
    expect(first.state.calls).toBe(1);
  });

  test("rejects when every verifier rejects", async () => {
    const composite = new CompositeVerifier([counting(null).verifier, counting(null).verifier]);

    expect(await composite.verify("t")).toBeNull();
  });

  test("rejects when there are no verifiers at all", async () => {
    expect(await new CompositeVerifier([]).verify("t")).toBeNull();
  });
});
