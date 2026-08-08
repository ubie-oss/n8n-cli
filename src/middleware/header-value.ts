/**
 * Validation for secrets that are about to become HTTP header values.
 *
 * A token mounted from a file — the usual shape for a secret-store volume —
 * arrives with a trailing newline more often than not. `Headers.set` rejects
 * that, and it does so inside the client pipeline: every matching request turns
 * into a 502 carrying an "Invalid header value" message, far from the config
 * that caused it. Middlewares that resolve secrets at build time run them
 * through here so the same mistake stops the proxy at startup instead.
 */

/** CR, LF, NUL and the rest of the C0/DEL range a header value may not carry. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Trims surrounding whitespace and rejects what remains if it cannot be sent.
 *
 * Trimming rather than rejecting: a trailing newline is an artifact of how the
 * secret was delivered, never part of the credential, and failing on it would
 * make every file-mounted secret a support ticket. Embedded control characters
 * are a different matter — they mean the value is not the secret anyone
 * intended, and header injection is the interesting failure mode.
 *
 * @param context what to name in the error, e.g.
 *   `bearer-token-inject: rule for /mcp-server/`
 */
export function sanitizeHeaderValue(raw: string, context: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${context}: token is empty (after trimming surrounding whitespace)`);
  }
  if (hasControlCharacter(value)) {
    throw new Error(
      `${context}: token contains a character that cannot appear in an HTTP ` +
        "header value (a line break or control character). Check how the secret " +
        "is mounted — surrounding whitespace is trimmed, embedded breaks are not.",
    );
  }
  return value;
}
