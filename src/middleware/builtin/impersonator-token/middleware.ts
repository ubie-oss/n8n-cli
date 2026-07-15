import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";
import type { UserTokenSource } from "./user-token-source.ts";

export interface ImpersonatorTokenOptions {
  /**
   * `aud` for the minted id_token. Almost always the gcloud ADC OAuth
   * client_id (`764086051850-...`) because that's what user
   * `application-default login` credentials produce via the
   * refresh-token grant. Configurable so operators aren't hard-coded to
   * one Google-managed constant.
   */
  audience: string;
  /**
   * Header to write the token to. Default is `X-Impersonator-Id-Token`
   * to match the convention established by `mcp-gcloud-adc-proxy` and the
   * receiving `impersonator-verify` server middleware.
   */
  headerName: string;
  /**
   * Where the user id_token comes from. Defaults to `AdcUserTokenSource`
   * in the factory; tests inject a static source.
   */
  tokenSource: UserTokenSource;
  /**
   * On failure to obtain a user id_token, either abort the outgoing
   * request (`throw`) or continue without the header (`skip`). `skip` is
   * the safe default for endpoints that also serve machine callers —
   * the SA-only path still works.
   */
  onError: "throw" | "skip";
}

/**
 * Client middleware that attaches a user-owned id_token as
 * `X-Impersonator-Id-Token` alongside the SA-owned Bearer set by
 * `iap-auth`. A cooperating receiver (`impersonator-verify` on the server
 * side, or any handler that reads a signed Google id_token side header)
 * validates the token and rewrites its effective identity to the user,
 * enabling per-person authorization even when the bearer must be an SA
 * (aud constraint).
 *
 * Order note: register this AFTER `iap-auth` in the client middleware
 * chain — `iap-auth` writes Authorization, this one writes a separate
 * header, so order isn't semantically load-bearing, but keeping bearer
 * first mirrors how the wire looks.
 */
export class ImpersonatorTokenMiddleware implements ClientMiddleware {
  readonly name = "impersonator-token";

  constructor(private readonly options: ImpersonatorTokenOptions) {}

  async apply(headers: Headers, _ctx: ClientMiddlewareContext): Promise<void> {
    try {
      const token = await this.options.tokenSource.getToken(this.options.audience);
      if (!token) return;
      headers.set(this.options.headerName, token);
    } catch (err) {
      if (this.options.onError === "throw") throw err;
      // skip: leave the header off — server treats the request as
      // SA-only. Callers that require the header should set onError=throw.
    }
  }
}
