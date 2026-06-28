import { describe, expect, test } from "bun:test";
import { decodeJWTClaim, resolveIdentity } from "@/middleware/identity.ts";

function makeReq(headers: Record<string, string>): Request {
  return new Request("http://localhost/", { headers });
}

function makeJWT(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

function base64url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

describe("identity: source=header raw", () => {
  test("returns the header value when present", () => {
    const id = resolveIdentity(
      { source: "header", name: "X-User-Email", decode: "raw" },
      { request: makeReq({ "x-user-email": "ryo@example.com" }), env: {} },
    );
    expect(id).toBe("ryo@example.com");
  });

  test("returns undefined when header missing", () => {
    expect(
      resolveIdentity(
        { source: "header", name: "X-User-Email" },
        { request: makeReq({}), env: {} },
      ),
    ).toBeUndefined();
  });

  test("returns undefined when source=header but no request", () => {
    expect(
      resolveIdentity({ source: "header", name: "X-User-Email" }, { env: {} }),
    ).toBeUndefined();
  });
});

describe("identity: source=header decode=jwt", () => {
  test("extracts email claim from JWT", () => {
    const jwt = makeJWT({ email: "ryo@example.com", sub: "u123" });
    const id = resolveIdentity(
      { source: "header", name: "X-Auth", decode: "jwt", claim: "email" },
      { request: makeReq({ "x-auth": jwt }), env: {} },
    );
    expect(id).toBe("ryo@example.com");
  });

  test("strips Bearer prefix transparently", () => {
    const jwt = makeJWT({ email: "ryo@example.com" });
    const id = resolveIdentity(
      { source: "header", name: "Authorization", decode: "jwt", claim: "email" },
      { request: makeReq({ authorization: `Bearer ${jwt}` }), env: {} },
    );
    expect(id).toBe("ryo@example.com");
  });

  test("missing claim returns undefined", () => {
    const jwt = makeJWT({ sub: "u123" });
    const id = resolveIdentity(
      { source: "header", name: "X-Auth", decode: "jwt", claim: "email" },
      { request: makeReq({ "x-auth": jwt }), env: {} },
    );
    expect(id).toBeUndefined();
  });

  test("malformed JWT returns undefined (no crash)", () => {
    const id = resolveIdentity(
      { source: "header", name: "X-Auth", decode: "jwt", claim: "email" },
      { request: makeReq({ "x-auth": "not-a-jwt" }), env: {} },
    );
    expect(id).toBeUndefined();
  });
});

describe("identity: source=env", () => {
  test("returns env var value", () => {
    expect(
      resolveIdentity(
        { source: "env", name: "USER_EMAIL" },
        { env: { USER_EMAIL: "ryo@example.com" } },
      ),
    ).toBe("ryo@example.com");
  });

  test("returns undefined when env var unset", () => {
    expect(resolveIdentity({ source: "env", name: "USER_EMAIL" }, { env: {} })).toBeUndefined();
  });
});

describe("identity: source=none / undefined spec", () => {
  test("source=none yields undefined", () => {
    expect(resolveIdentity({ source: "none" }, { env: {} })).toBeUndefined();
  });

  test("undefined spec yields undefined", () => {
    expect(resolveIdentity(undefined, { env: {} })).toBeUndefined();
  });
});

describe("decodeJWTClaim", () => {
  test("works for non-string claims (returns undefined)", () => {
    const jwt = makeJWT({ exp: 12345 });
    expect(decodeJWTClaim(jwt, "exp")).toBeUndefined();
  });
});
