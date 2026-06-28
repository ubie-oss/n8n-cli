/**
 * Identity extraction for the middleware pipeline.
 *
 * The pipeline runs in two distinct contexts:
 *
 *   proxy  — the request itself carries the actor identity in a header
 *            populated by an upstream authenticating proxy. The header
 *            name is fully configurable.
 *   apply  — there is no incoming request; identity comes from the
 *            environment of the CLI invocation.
 *
 * To keep middleware code from caring about which is which, identity is
 * resolved once at the pipeline entry and stuffed into `PreWriteContext`.
 *
 * JWT support is minimal: base64url-decode the payload and pull a single
 * claim. We do NOT verify the signature — this is "guardrail" identity, not
 * a security boundary. If callers need verified identity they should
 * terminate the JWT at an authenticating proxy upstream and forward the
 * claim (or the already-extracted email) as a plain header.
 */

export interface IdentitySpec {
  /** Where to look for the identity. `none` disables identity extraction. */
  source: "header" | "env" | "none";
  /** Header name (source=header) or env var name (source=env). */
  name?: string;
  /** Optional decode strategy. */
  decode?: "raw" | "jwt";
  /** Claim name when decode=jwt. */
  claim?: string;
}

export interface IdentityContext {
  request?: Request;
  env: NodeJS.ProcessEnv;
}

export function resolveIdentity(
  spec: IdentitySpec | undefined,
  ctx: IdentityContext,
): string | undefined {
  if (!spec || spec.source === "none") return undefined;

  const raw =
    spec.source === "header" ? readHeader(ctx.request, spec.name) : readEnv(ctx.env, spec.name);

  if (raw === undefined || raw === "") return undefined;
  if (spec.decode === "jwt") {
    return decodeJWTClaim(raw, spec.claim ?? "email");
  }
  return raw;
}

function readHeader(req: Request | undefined, name: string | undefined): string | undefined {
  if (!req || !name) return undefined;
  const v = req.headers.get(name);
  return v === null ? undefined : v;
}

function readEnv(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
  if (!name) return undefined;
  return env[name];
}

/**
 * Decodes the payload of a (possibly Bearer-prefixed) JWT and returns the
 * requested string claim. Returns undefined if the token is malformed or
 * the claim is missing — callers translate undefined into "no identity",
 * which the authz middleware will treat as deny under fail-closed config.
 */
export function decodeJWTClaim(token: string, claim: string): string | undefined {
  let raw = token.trim();
  if (raw.toLowerCase().startsWith("bearer ")) raw = raw.slice(7).trim();
  const parts = raw.split(".");
  if (parts.length < 2) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    const decoded = base64UrlDecode(payload);
    const obj = JSON.parse(decoded) as Record<string, unknown>;
    const value = obj[claim];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlDecode(input: string): string {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder("utf-8").decode(Buffer.from(b64, "base64"));
}
