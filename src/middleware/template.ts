/**
 * Minimal template expansion for middleware-supplied HTTP request blobs.
 *
 * Two forms are recognized:
 *
 *   ${env:VAR}         → process.env[VAR]; empty string when unset
 *   ${json:identity}   → JSON.stringify(identity); empty string when undefined
 *
 * The grammar is deliberately small: this is for proxy config values like
 *   '{"email": ${json:identity}}'
 * not a general-purpose templating language. Users that need more should
 * write a wrapper script and inject already-rendered values via env.
 *
 * `${json:identity}` produces a *JSON value* (quoted string for identities),
 * so it can be embedded directly into a JSON body without manual escaping.
 * `${env:X}` produces the raw env value — useful in headers
 * (`Authorization: Bearer ${env:TOKEN}`).
 *
 * Unknown variables expand to "" rather than throwing because env-driven
 * config is commonly set up by a deployment system that may roll out values
 * out of order; throwing at startup is friendlier than throwing per-request,
 * but throwing per-template is worst-of-both — left to the caller to
 * validate via zod schemas after expansion.
 */
export interface TemplateBindings {
  env: NodeJS.ProcessEnv;
  identity?: string;
}

const TOKEN_RE = /\$\{(env|json):([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandTemplate(input: string, bindings: TemplateBindings): string {
  return input.replace(TOKEN_RE, (_, kind: string, name: string) => {
    if (kind === "env") {
      return bindings.env[name] ?? "";
    }
    if (kind === "json") {
      if (name !== "identity") {
        // Only `identity` is exposed today; future bindings would be added
        // explicitly here so each new variable is reviewable.
        return "";
      }
      if (bindings.identity === undefined) return '""';
      return JSON.stringify(bindings.identity);
    }
    return "";
  });
}

/**
 * Expands every value in a record, useful for header maps in middleware
 * config. Keys are not expanded — they are header/JSON-key names, not data.
 */
export function expandRecord(
  record: Record<string, string>,
  bindings: TemplateBindings,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = expandTemplate(v, bindings);
  }
  return out;
}
