import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";

/**
 * One path-scoped bearer-token injection.
 *
 * Scoping is the point, exactly as in `webhook-token-inject`. The token here is
 * an application-layer credential for one specific upstream surface (n8n's
 * instance-level MCP server, say). Putting it on every upstream call would hand
 * that credential to every endpoint the proxy can reach, including ones the
 * operator never meant to speak for. Each rule therefore names the prefix it is
 * allowed to speak for.
 */
export interface BearerTokenRule {
  /**
   * Prefix matched against the *incoming* request pathname (e.g.
   * `/mcp-server/`). Trailing slash matters: `/mcp-ser` would otherwise also
   * match `/mcp-server-admin`.
   */
  pathPrefix: string;
  /** Token value. Never logged, never echoed back to the caller. */
  token: string;
  /**
   * Auth scheme prefixed to the token, e.g. `Bearer` → `Authorization: Bearer
   * <token>`. Empty string writes the raw value, for the rare upstream that
   * wants an unprefixed credential.
   */
  scheme: string;
}

export interface BearerTokenInjectOptions {
  /**
   * Rules in declaration order. **Every** matching rule is applied, not just
   * the first, and the last match wins — all rules write the same header, so a
   * broad rule plus a narrower one on top resolves the way the reading order
   * suggests.
   */
  rules: BearerTokenRule[];
}

/**
 * Client middleware that attaches an application-layer token as
 * `Authorization` on upstream requests whose path falls under a configured
 * prefix.
 *
 * This exists because `Authorization` is contested when the upstream sits
 * behind Google IAP: IAP authenticates with that header and consumes it, so an
 * application that also wants a bearer token there never sees one. Configuring
 * `iap-auth` to emit `proxy-authorization` frees `Authorization` up, and this
 * middleware fills it — see the README section on MCP for the full split.
 *
 * Only ever sets its header, never deletes: the client's own `Authorization`
 * is discarded before the pipeline runs (see `forwardRequest`), so this
 * middleware's position in the chain does not change the outcome. The one
 * ordering constraint left is a self-inflicted one — running this alongside
 * `iap-auth` in its default `authorization` mode has the two fight over the
 * same header, which is a misconfiguration rather than a supported setup.
 */
export class BearerTokenInjectMiddleware implements ClientMiddleware {
  readonly name = "bearer-token-inject";

  constructor(private readonly options: BearerTokenInjectOptions) {}

  apply(headers: Headers, ctx: ClientMiddlewareContext): void {
    for (const rule of this.options.rules) {
      if (!ctx.pathname.startsWith(rule.pathPrefix)) continue;
      headers.set("authorization", rule.scheme ? `${rule.scheme} ${rule.token}` : rule.token);
    }
  }
}
