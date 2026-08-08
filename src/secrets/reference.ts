import type { SecretRef } from "./types.ts";

/**
 * Matches a whole value that is a secret reference.
 *
 * Anchored on purpose: only a value that is *entirely* a reference is treated
 * as one. Substituting references inside a larger string would mean guessing
 * where the reference ends, and a credential field that happens to contain a
 * URL — an OAuth endpoint, a webhook target — would start being interpreted as
 * a secret lookup. A field that needs a secret embedded in a longer string is
 * better served by putting the whole string in the secret store.
 *
 * The scheme grammar is deliberately narrow (letters, digits, `-`) so that a
 * plain `https://...` or `postgres://...` value can never match a scheme this
 * CLI would claim.
 */
const REFERENCE_PATTERN = /^([a-z][a-z0-9-]*):\/\/(.+)$/i;

/**
 * Parses a value into a secret reference, or returns null when it is not one.
 *
 * Returning null rather than throwing is what lets the walker leave ordinary
 * credential values alone without the caller having to classify them first.
 */
export function parseSecretRef(value: string): SecretRef | null {
  const match = REFERENCE_PATTERN.exec(value);
  if (!match) return null;

  const scheme = match[1]!.toLowerCase();
  const locator = match[2]!;
  return { scheme, locator, raw: value };
}

/**
 * True when the value looks like a reference to one of the given schemes.
 *
 * Used to decide whether a credential file still needs resolving without
 * actually resolving it — `--dry-run` reports which fields would be fetched,
 * and must not fetch them to find out.
 */
export function isSecretRefFor(value: unknown, schemes: Iterable<string>): boolean {
  if (typeof value !== "string") return false;
  const ref = parseSecretRef(value);
  if (!ref) return false;
  for (const scheme of schemes) {
    if (scheme.toLowerCase() === ref.scheme) return true;
  }
  return false;
}
