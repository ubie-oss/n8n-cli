import type { ClientMiddleware, ClientMiddlewareContext } from "@/middleware/types.ts";
import type { UserTokenSource } from "./user-token-source.ts";

export interface ImpersonatorTokenOptions {
  /**
   * `aud` for the minted id_token — the OAuth client that issued the
   * credentials, since the refresh-token grant will not mint a token for a
   * client in another project.
   *
   * Leave empty to let the token source name its own audience (see
   * `UserTokenSource.defaultAudience`). That is the safer default: a
   * hard-coded constant that doesn't match the credentials actually in use
   * fails at the far end, where the error says only "verification failed".
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
    // Drop whatever is already on the header before doing any work, mirroring
    // how iap-auth treats Authorization.
    //
    // In proxy mode these headers come from the *incoming* request, so without
    // this a caller could supply their own X-Impersonator-Id-Token and have it
    // forwarded verbatim on any path where this middleware then declines to
    // write one — an empty token, or a mint failure under the default
    // onError=skip. It would reach the upstream looking like the proxy vouched
    // for it. Deleting first makes the header mean exactly one thing: this
    // middleware minted it on this hop.
    //
    // `impersonator-verify` checks the signature, so this is not the only
    // thing standing between a forged header and a trusted identity — but a
    // receiver that reads the header without verifying is a plausible
    // deployment, and the header should not survive a hop that failed to
    // authenticate it.
    headers.delete(this.options.headerName);

    try {
      const token = await this.options.tokenSource.getToken(await this.resolveAudience());
      if (!token) return;
      headers.set(this.options.headerName, token);
    } catch (err) {
      if (this.options.onError === "throw") throw err;
      // skip: leave the header off — server treats the request as
      // SA-only. Callers that require the header should set onError=throw.
    }
  }

  /** Configured audience, else whatever the token source derives from its credentials. */
  private async resolveAudience(): Promise<string> {
    if (this.options.audience) return this.options.audience;
    const derived = await this.options.tokenSource.defaultAudience?.();
    if (derived) return derived;
    throw new Error(
      "impersonator-token: no audience configured and the token source could not derive one. " +
        "Set N8N_IMPERSONATOR_TOKEN_AUDIENCE (or --impersonator-token-audience).",
    );
  }
}
