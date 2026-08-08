import { EnvSecretResolver } from "./env.ts";
import { GcpSecretManagerResolver } from "./gcp.ts";
import { parseSecretRef } from "./reference.ts";
import { type SecretRef, SecretResolveError, type SecretResolver } from "./types.ts";

/**
 * Builds the resolvers available to a run.
 *
 * Constructed eagerly but connected to nothing: `GcpSecretManagerResolver`
 * defers every bit of Google authentication to its first `resolve()`, so a user
 * who never writes a `gcp-sm://` reference never needs Google credentials.
 */
export function defaultSecretResolvers(): SecretResolver[] {
  return [new EnvSecretResolver(), new GcpSecretManagerResolver()];
}

/**
 * Walks a value, replacing every string that is a secret reference with the
 * secret it names.
 *
 * Recurses through objects and arrays because credential data is arbitrarily
 * nested — an OAuth credential keeps its token under `oauthTokenData`, not at
 * the top level. Object keys are never treated as references: a key is a field
 * name in a credential schema, and rewriting one would produce a credential
 * n8n cannot interpret.
 *
 * A string whose scheme belongs to no registered resolver is left exactly as it
 * is. That is what allows an ordinary `https://...` or `postgres://...` value to
 * sit in the same object as a reference.
 */
export async function resolveSecretRefs(
  value: unknown,
  resolvers: SecretResolver[],
): Promise<unknown> {
  const byScheme = new Map(resolvers.map((r) => [r.scheme.toLowerCase(), r]));
  return await walk(value, byScheme, []);
}

/** Lists the references in a value without resolving any of them. */
export function findSecretRefs(
  value: unknown,
  resolvers: SecretResolver[],
): Array<{ path: string; ref: SecretRef }> {
  const schemes = new Set(resolvers.map((r) => r.scheme.toLowerCase()));
  const found: Array<{ path: string; ref: SecretRef }> = [];

  const visit = (node: unknown, trail: string[]): void => {
    if (typeof node === "string") {
      const ref = parseSecretRef(node);
      if (ref && schemes.has(ref.scheme)) found.push({ path: trail.join("."), ref });
      return;
    }
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, [...trail, String(i)]);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) visit(child, [...trail, key]);
    }
  };

  visit(value, []);
  return found;
}

async function walk(
  node: unknown,
  byScheme: Map<string, SecretResolver>,
  trail: string[],
): Promise<unknown> {
  if (typeof node === "string") {
    const ref = parseSecretRef(node);
    if (!ref) return node;

    const resolver = byScheme.get(ref.scheme);
    if (!resolver) return node;

    try {
      return await resolver.resolve(ref);
    } catch (err) {
      // Re-wrap with the field path. A credential can hold a dozen values and
      // "could not resolve gcp-sm://..." alone does not say which one to fix.
      if (err instanceof SecretResolveError) {
        throw new SecretResolveError(err.ref, `at ${trail.join(".") || "(root)"}: ${err.message}`);
      }
      throw err;
    }
  }

  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const [i, item] of node.entries()) {
      out.push(await walk(item, byScheme, [...trail, String(i)]));
    }
    return out;
  }

  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = await walk(child, byScheme, [...trail, key]);
    }
    return out;
  }

  return node;
}
