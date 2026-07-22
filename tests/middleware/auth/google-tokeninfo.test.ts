import { describe, expect, test } from "bun:test";
import { type FetchLike, GoogleTokeninfoVerifier } from "@/middleware/auth/google-tokeninfo.ts";
import { parseBearer } from "@/middleware/auth/types.ts";

function fetchResponding(status: number, body: unknown): FetchLike {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("parseBearer", () => {
  test("returns the token when present", () => {
    expect(parseBearer("Bearer abc")).toBe("abc");
    expect(parseBearer("bearer  xyz")).toBe("xyz");
  });
  test("returns null when absent or malformed", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
  });
});

describe("GoogleTokeninfoVerifier", () => {
  test("returns a normalized claim on 200", async () => {
    const verifier = new GoogleTokeninfoVerifier({
      fetcher: fetchResponding(200, {
        iss: "https://accounts.google.com",
        aud: "aud",
        email: "u@x.dev",
        email_verified: "true",
      }),
    });
    const claim = await verifier.verify("tok");
    expect(claim?.email).toBe("u@x.dev");
    expect(claim?.aud).toBe("aud");
    expect(claim?.emailVerified).toBe(true);
  });

  test("rejects non-Google issuers", async () => {
    const verifier = new GoogleTokeninfoVerifier({
      fetcher: fetchResponding(200, {
        iss: "https://evil.example.com",
        aud: "aud",
      }),
    });
    expect(await verifier.verify("tok")).toBeNull();
  });

  test("returns null on non-200", async () => {
    const verifier = new GoogleTokeninfoVerifier({
      fetcher: fetchResponding(400, { error: "bad" }),
    });
    expect(await verifier.verify("tok")).toBeNull();
  });

  test("returns null on network error", async () => {
    const verifier = new GoogleTokeninfoVerifier({
      fetcher: () => Promise.reject(new Error("network down")),
    });
    expect(await verifier.verify("tok")).toBeNull();
  });

  test("returns null when tokenless", async () => {
    const verifier = new GoogleTokeninfoVerifier({ fetcher: fetchResponding(200, {}) });
    expect(await verifier.verify("")).toBeNull();
  });

  test("caches successful verifications only", async () => {
    let calls = 0;
    const verifier = new GoogleTokeninfoVerifier({
      fetcher: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            iss: "https://accounts.google.com",
            aud: "aud",
            email: "u@x.dev",
            email_verified: "true",
            exp: String(Math.floor(Date.now() / 1000) + 3600), // 1h from now
          }),
          { status: 200 },
        );
      },
      cacheTtlMs: 60_000,
    });
    await verifier.verify("tok");
    await verifier.verify("tok");
    expect(calls).toBe(1);
  });

  test("does not cache negative responses", async () => {
    let calls = 0;
    const verifier = new GoogleTokeninfoVerifier({
      fetcher: async () => {
        calls++;
        return new Response("", { status: 400 });
      },
    });
    await verifier.verify("tok");
    await verifier.verify("tok");
    expect(calls).toBe(2);
  });

  test("cache entry expiry is capped at the token's own exp claim", async () => {
    // Token expiry is 100s from now; cache TTL is 5min. Cache MUST NOT
    // serve the token past 100s — that's the security invariant.
    let clock = 0;
    let calls = 0;
    const verifier = new GoogleTokeninfoVerifier({
      now: () => clock,
      cacheTtlMs: 5 * 60 * 1000,
      fetcher: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            iss: "https://accounts.google.com",
            aud: "aud",
            email: "u@x.dev",
            email_verified: "true",
            exp: "100", // 100s since epoch
          }),
          { status: 200 },
        );
      },
    });
    clock = 0;
    expect(await verifier.verify("tok")).not.toBeNull();
    expect(calls).toBe(1);
    clock = 50_000; // 50s later — still within token exp
    expect(await verifier.verify("tok")).not.toBeNull();
    expect(calls).toBe(1);
    clock = 101_000; // past token exp; cache MUST expire, forcing a refetch
    expect(await verifier.verify("tok")).not.toBeNull();
    expect(calls).toBe(2);
  });
});
