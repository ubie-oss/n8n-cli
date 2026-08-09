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

/**
 * Whether a character cannot survive `Headers.set`.
 *
 * Two classes, and the second is the one that actually bites. Control
 * characters (C0 and DEL) are the header-injection concern. But a header value
 * is Latin-1, so anything above U+00FF — a smart quote or a full-width
 * character pasted into a secret — is what the runtime rejects outright; a
 * trailing newline it merely trims. Same rule `headerSafe()` documents in
 * `src/proxy/server.ts`.
 */
function isUnsendable(code: number): boolean {
  return code < 0x20 || code === 0x7f || code > 0xff;
}

function hasUnsendableCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isUnsendable(value.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * Trims surrounding whitespace and rejects what remains if it cannot be sent.
 *
 * Trimming rather than rejecting: a trailing newline is an artifact of how the
 * secret was delivered, never part of the credential, and failing on it would
 * make every file-mounted secret a support ticket. What is left over is a
 * different matter — it means the value is not the secret anyone intended.
 *
 * @param context what to name in the error, e.g.
 *   `bearer-token-inject: rule for /mcp-server/`
 */
export function sanitizeHeaderValue(raw: string, context: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${context}: token is empty (after trimming surrounding whitespace)`);
  }
  if (hasUnsendableCharacter(value)) {
    throw new Error(
      `${context}: token contains a character that cannot appear in an HTTP ` +
        "header value (a line break, a control character, or a non-Latin-1 " +
        "character such as a smart quote). Check how the secret is mounted — " +
        "surrounding whitespace is trimmed, anything else is not.",
    );
  }
  return value;
}
