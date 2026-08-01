/**
 * Real key generation and JWS signing for verifier tests.
 *
 * Shared rather than stubbed on purpose: a verifier only proves it
 * rejects forgeries if the test can actually produce one.
 */

export type TestKeys = { privateKey: CryptoKey; publicJwk: Record<string, unknown> };

export async function generateRsaKeys(kid: string): Promise<TestKeys> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export async function generateEcKeys(kid: string): Promise<TestKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function encodeSegment(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Sign a compact JWS. `header` overrides are shallow-merged so a test can
 * misdeclare `alg` / `kid` while still producing a real signature.
 */
export async function signJwt(
  keys: TestKeys,
  payload: Record<string, unknown>,
  overrides: { header?: Record<string, unknown>; alg?: "RS256" | "ES256" } = {},
): Promise<string> {
  const alg = overrides.alg ?? "RS256";
  const header = { alg, kid: keys.publicJwk.kid, typ: "JWT", ...overrides.header };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const params =
    alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  const signature = await crypto.subtle.sign(
    params,
    keys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}
