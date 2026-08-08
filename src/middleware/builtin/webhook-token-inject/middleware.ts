import type { HeaderClaim } from "@/middleware/header-claims.ts";
import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";

/**
 * One path-scoped token injection.
 *
 * Scoping is the point. A webhook token is not a gateway credential: it is the
 * shared secret one specific family of webhook nodes checks. Injecting it on
 * every upstream call would mean "anyone who can reach the proxy can satisfy
 * that header anywhere it is checked" — including webhooks the operator never
 * meant to expose through this path. Each rule therefore names the prefix it
 * is allowed to speak for.
 */
export interface WebhookTokenRule {
  /**
   * Prefix matched against the *incoming* request pathname (e.g.
   * `/webhook/some-namespace/`). Trailing slash matters: `/webhook/ab` would
   * otherwise also match `/webhook/abc`.
   */
  pathPrefix: string;
  /** Header the token is written to. */
  header: string;
  /** Token value. Never logged, never echoed back to the caller. */
  token: string;
  /**
   * Behavior when the incoming request already carries a value for `header`:
   *   - "set-if-absent": leave it intact. Default — a caller that still brings
   *     its own token keeps working while a deployment migrates.
   *   - "replace": overwrite, making the proxy the single token holder.
   *
   * One caveat for a rule whose `header` is `Authorization`: when the chain
   * also contains a middleware that claims the credential headers (see
   * `headerClaims`), the caller's value is already gone by the time this runs,
   * so "set-if-absent" behaves like "replace". Webhook tokens normally live in
   * their own header, where this does not arise.
   */
  conflictPolicy: "replace" | "set-if-absent";
}

export interface WebhookTokenInjectOptions {
  /**
   * Rules in declaration order. **Every** matching rule is applied, not just
   * the first: distinct webhook families use distinct headers, and a
   * deployment may legitimately want a broad rule plus a narrower one on top.
   * When two matching rules share a header, the later one decides (subject to
   * its own conflictPolicy).
   */
  rules: WebhookTokenRule[];
}

/**
 * Client middleware that attaches webhook tokens to upstream requests whose
 * path falls under a configured prefix.
 *
 * Used to make the proxy the single holder of the shared secrets that webhook
 * nodes check. Callers then need only authenticate to the proxy itself; they
 * never hold — and cannot leak — the webhook tokens. A request that bypasses
 * the proxy carries no token and is rejected by n8n, which is what keeps a
 * second, unauthenticated ingress from becoming an open door.
 *
 * Carries no knowledge of any particular naming convention: prefixes, header
 * names and tokens are all supplied by configuration.
 */
export class WebhookTokenInjectMiddleware implements ClientMiddleware {
  readonly name = "webhook-token-inject";
  readonly headerClaims: readonly HeaderClaim[];

  constructor(private readonly options: WebhookTokenInjectOptions) {
    // Only the "replace" rules claim, and only over their own prefix. Those are
    // the ones that make the proxy the single holder of that value; a
    // "set-if-absent" rule says the opposite by design — the caller's value
    // wins — so it neither conflicts with another writer nor licenses
    // discarding what the caller sent.
    this.headerClaims = options.rules
      .filter((r) => r.conflictPolicy === "replace")
      .map((r) => ({ header: r.header, pathPrefix: r.pathPrefix }));
  }

  apply(headers: Headers, ctx: ClientMiddlewareContext): void {
    for (const rule of this.options.rules) {
      if (!ctx.pathname.startsWith(rule.pathPrefix)) continue;
      if (rule.conflictPolicy === "set-if-absent" && headers.has(rule.header)) continue;
      headers.set(rule.header, rule.token);
    }
  }
}
