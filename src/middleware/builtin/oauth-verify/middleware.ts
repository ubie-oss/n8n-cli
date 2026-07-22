import { GoogleTokeninfoVerifier } from "@/middleware/auth/google-tokeninfo.ts";
import { type IdTokenVerifier, parseBearer } from "@/middleware/auth/types.ts";
import type {
  MiddlewareVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";
import type { OAuthVerifyOptions } from "./types.ts";

/**
 * Server middleware that verifies the `Authorization: Bearer` token as a
 * signed id_token via a pluggable `IdTokenVerifier`.
 *
 * On success:
 *   - `ctx.auth.bearer` is populated with the verified claim.
 *   - `ctx.identity` is set to the verified email (mirrors the legacy
 *     contract used by the existing `authz` middleware).
 *   - `ctx.auth.effective` is set to the bearer's email; a later
 *     `impersonator-verify` may overwrite it when a trusted principal
 *     forwards a user token.
 *
 * On failure (missing token, wrong aud, unverified email, verifier
 * rejection): behavior depends on `enforce` — `deny` blocks with 401,
 * `warn` allows through with a warning violation, `off` passes silently.
 *
 * The verifier is completely decoupled from the middleware. The default
 * (`GoogleTokeninfoVerifier`) fits deployments where callers present
 * Google-signed id_tokens; other issuers plug in their own `IdTokenVerifier`
 * via `options.verifier` and the pipeline logic here doesn't change.
 *
 * Modes: this middleware only runs meaningfully when there's a request
 * (i.e. `mode === "proxy"`). Apply / single mode has no HTTP request, so
 * we pass through — `--server-middleware` chains that include this one
 * for both modes stay usable without special-casing.
 */
export class OAuthVerifyMiddleware implements ServerMiddleware {
  readonly name = "oauth-verify";
  private readonly verifier: IdTokenVerifier;
  private readonly expectedAud: Set<string>;
  private readonly trustedPrincipals: Set<string>;

  constructor(private readonly options: OAuthVerifyOptions) {
    this.verifier = options.verifier ?? new GoogleTokeninfoVerifier();
    this.expectedAud = new Set(options.expectedAudiences);
    this.trustedPrincipals = new Set(options.trustedPrincipals);
  }

  async evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> {
    if (this.options.enforce === "off") return { block: false, violations: [] };
    if (ctx.mode !== "proxy" || !ctx.request) {
      // Apply / single mode has no HTTP request; nothing to verify.
      return { block: false, violations: [] };
    }

    const authHeader = ctx.request.headers.get("authorization");
    const token = parseBearer(authHeader);
    if (!token) return this.reject("missing bearer");

    if (this.expectedAud.size === 0) {
      return this.reject("no expected audiences configured");
    }

    const claim = await this.verifier.verify(token);
    if (!claim) return this.reject("verifier rejected the token");
    if (!this.expectedAud.has(claim.aud)) {
      // Do NOT echo the received aud back to the caller — that's an oracle.
      return this.reject("audience not accepted");
    }
    if (!claim.emailVerified || !claim.email) {
      return this.reject("email not verified");
    }

    // Populate auth context so downstream middlewares can rely on it.
    // We stash trusted-principal membership on the request so
    // `impersonator-verify` doesn't need to re-read this config.
    const bearer = {
      email: claim.email,
      aud: claim.aud,
      verified: true as const,
    };
    ctx.auth = {
      ...(ctx.auth ?? {}),
      bearer,
      effective: { email: claim.email, layer: "bearer" as const },
    };
    ctx.identity = claim.email;
    (ctx as { __oauthVerifyBearerIsTrusted?: boolean }).__oauthVerifyBearerIsTrusted =
      this.trustedPrincipals.has(claim.email);
    return { block: false, violations: [] };
  }

  private reject(reason: string): MiddlewareVerdict {
    const violation = {
      rule: "oauth-verify-rejected",
      severity: "error" as const,
      message: `Bearer verification failed: ${reason}`,
    };
    if (this.options.enforce === "warn") {
      return { block: false, violations: [{ ...violation, severity: "warning" }] };
    }
    return {
      block: true,
      violations: [violation],
      denial: {
        status: 401,
        error: "bearer_verification_failed",
        // Generic message — the specific reason lives in server-side
        // logs (via the violation) rather than leaking to the caller.
        message: "Bearer verification failed.",
      },
    };
  }
}
