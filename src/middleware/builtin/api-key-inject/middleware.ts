import type { HeaderClaim } from "@/middleware/header-claims.ts";
import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";

export interface ApiKeyInjectOptions {
  /** Header name (default: X-N8N-API-KEY). */
  header: string;
  /** Concrete API key value. Never logged. */
  apiKey: string;
  /**
   * Behavior when the incoming request already carries a value for `header`:
   *   - "replace": overwrite. Default — the proxy is the single key holder.
   *   - "set-if-absent": leave existing values intact. Useful during a
   *     migration where some clients still bring their own key.
   */
  conflictPolicy: "replace" | "set-if-absent";
}

/**
 * Client middleware that injects a (typically shared) n8n API key into
 * every outgoing upstream request. Used together with `iap-auth` to make
 * the proxy the single authentication terminator — clients only need to
 * authenticate against IAP (or whatever fronts the proxy); they don't
 * need an n8n API key of their own.
 */
export class ApiKeyInjectMiddleware implements ClientMiddleware {
  readonly name = "api-key-inject";
  readonly headerClaims: readonly HeaderClaim[];

  constructor(private readonly options: ApiKeyInjectOptions) {
    // `header` is configurable, so this middleware can be pointed at
    // `Authorization` like any other. Claiming it keeps that configuration
    // inside the same conflict check as everything else instead of letting
    // chain order decide. Under "set-if-absent" it defers to the caller and so
    // claims nothing.
    this.headerClaims = options.conflictPolicy === "replace" ? [{ header: options.header }] : [];
  }

  apply(headers: Headers, _ctx: ClientMiddlewareContext): void {
    if (this.options.conflictPolicy === "set-if-absent" && headers.has(this.options.header)) {
      return;
    }
    headers.set(this.options.header, this.options.apiKey);
  }
}
