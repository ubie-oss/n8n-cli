import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";
import type { TokenSource } from "./token-source.ts";

export interface IapAuthOptions {
  /** OAuth2 client_id of the IAP-protected upstream — becomes the `aud` claim. */
  audience: string;
  /** Token source. Defaults to GCE metadata server in the factory. */
  tokenSource: TokenSource;
}

/**
 * Client middleware that mints a Google-signed id_token for an IAP-protected
 * upstream and attaches it as `Authorization: Bearer <token>`.
 *
 * Always replaces any incoming `Authorization` — the client-side token (used
 * to authenticate against the proxy's *own* IAP layer, IAP#1) has a different
 * `aud` than the upstream's IAP (IAP#2), so passing it through would result
 * in audience-mismatch 401s at the second hop.
 *
 * The previous `Authorization` value is dropped before the new one is set.
 * If you need the user's identity to reach the upstream, configure IAP#1 to
 * inject `X-Goog-Authenticated-User-Email` (which is a separate header and
 * isn't touched here).
 */
export class IapAuthMiddleware implements ClientMiddleware {
  readonly name = "iap-auth";

  constructor(private readonly options: IapAuthOptions) {}

  async apply(headers: Headers, _ctx: ClientMiddlewareContext): Promise<void> {
    const token = await this.options.tokenSource.getToken(this.options.audience);
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${token}`);
  }
}
