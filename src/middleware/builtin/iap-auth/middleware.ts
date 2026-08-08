import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";
import type { TokenSource } from "./token-source.ts";

/**
 * Header the minted id_token is written to.
 *
 * `authorization` is the default and the historical behavior. IAP also accepts
 * the id_token in `Proxy-Authorization`, and when it does it forwards
 * `Authorization` to the backend untouched
 * (https://docs.cloud.google.com/iap/docs/authentication-howto). That is the
 * only way an application-layer bearer token can reach an IAP-protected
 * upstream, because IAP consumes the `Authorization` it authenticates with.
 */
export type IapAuthHeaderName = "authorization" | "proxy-authorization";

export interface IapAuthOptions {
  /** OAuth2 client_id of the IAP-protected upstream — becomes the `aud` claim. */
  audience: string;
  /** Token source. Defaults to GCE metadata server in the factory. */
  tokenSource: TokenSource;
  /** Where to write the id_token. Defaults to `authorization`. */
  headerName?: IapAuthHeaderName;
}

/**
 * Client middleware that mints a Google-signed id_token for an IAP-protected
 * upstream and attaches it as `<headerName>: Bearer <token>`.
 *
 * This middleware only ever *adds* its own header. Discarding whatever the
 * client brought in `Authorization` is the proxy's job and happens before the
 * pipeline runs (see `forwardRequest`), which keeps the result independent of
 * where this middleware sits in the chain.
 *
 * When `headerName` is `proxy-authorization`, `Authorization` is left entirely
 * alone so a later middleware can put an application-layer token there. If you
 * need the user's identity to reach the upstream, configure the proxy's own IAP
 * to inject `X-Goog-Authenticated-User-Email` (a separate header, never touched
 * here).
 */
export class IapAuthMiddleware implements ClientMiddleware {
  readonly name = "iap-auth";

  constructor(private readonly options: IapAuthOptions) {}

  async apply(headers: Headers, _ctx: ClientMiddlewareContext): Promise<void> {
    const token = await this.options.tokenSource.getToken(this.options.audience);
    headers.set(this.options.headerName ?? "authorization", `Bearer ${token}`);
  }
}
