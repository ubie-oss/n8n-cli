import { GoogleTokeninfoVerifier } from "@/middleware/auth/google-tokeninfo.ts";
import type { IdTokenVerifier } from "@/middleware/auth/types.ts";
import type {
  MiddlewareVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";
import { DEFAULT_IMPERSONATOR_HEADER, type ImpersonatorVerifyOptions } from "./types.ts";

/**
 * Server middleware that verifies the impersonator id_token (default
 * header: `X-Impersonator-Id-Token`) attached by a cooperating client on
 * behalf of the human running the CLI.
 *
 * Rationale: many deployments authenticate the bearer as a machine
 * principal (a service account, workload identity, agent token, etc.)
 * because that's the only shape of credential the caller can produce
 * with the required `aud`. In those cases the bearer's `email` claim is
 * the machine's address — the real human's identity is lost. Clients
 * that want the server to attribute the call to the actual person
 * forward the user's own id_token in a side header; this middleware
 * validates it.
 *
 * Trust contract:
 *   1. `oauth-verify` MUST run before this middleware, so
 *      `ctx.auth.bearer` is populated. Absence is treated as failure.
 *   2. The bearer principal MUST be in `oauth-verify`'s
 *      `trustedPrincipals` list. This prevents random human callers from
 *      spoofing arbitrary user emails by attaching a header.
 *   3. The impersonator token itself MUST verify against
 *      `expectedAudiences` and carry a verified email.
 *
 * When all three hold, `ctx.auth.effective` and `ctx.identity` are
 * rewritten to the impersonator's email. Downstream authz reads the new
 * identity transparently.
 */
export class ImpersonatorVerifyMiddleware implements ServerMiddleware {
  readonly name = "impersonator-verify";
  private readonly verifier: IdTokenVerifier;
  private readonly expectedAud: Set<string>;
  private readonly headerName: string;

  constructor(private readonly options: ImpersonatorVerifyOptions) {
    this.verifier = options.verifier ?? new GoogleTokeninfoVerifier();
    this.expectedAud = new Set(options.expectedAudiences);
    this.headerName = options.headerName ?? DEFAULT_IMPERSONATOR_HEADER;
  }

  async evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> {
    if (this.options.enforce === "off") return { block: false, violations: [] };
    if (ctx.mode !== "proxy" || !ctx.request) {
      return { block: false, violations: [] };
    }

    const raw = ctx.request.headers.get(this.headerName);
    if (!raw) {
      if (this.options.requirement === "require") {
        return this.reject("missing impersonator token");
      }
      return { block: false, violations: [] };
    }

    // Bearer must be present *and* trusted before we honor an impersonator.
    // Without oauth-verify running upstream we have no way to know if the
    // bearer principal is trusted — the safe stance is refuse.
    if (!ctx.auth?.bearer) {
      return this.reject("impersonator forwarded but bearer not verified");
    }
    const trusted = (ctx as { __oauthVerifyBearerIsTrusted?: boolean })
      .__oauthVerifyBearerIsTrusted;
    if (!trusted) {
      return this.reject("bearer principal is not trusted to forward an impersonator token");
    }

    if (this.expectedAud.size === 0) {
      return this.reject("no expectedAudiences configured for impersonator");
    }

    const claim = await this.verifier.verify(raw);
    if (!claim) return this.reject("verifier rejected the impersonator token");
    if (!this.expectedAud.has(claim.aud)) {
      // Do NOT echo the received aud back to the caller.
      return this.reject("impersonator audience not accepted");
    }
    if (!claim.emailVerified || !claim.email) {
      return this.reject("impersonator email not verified");
    }

    const impersonator = {
      email: claim.email,
      aud: claim.aud,
      verified: true as const,
    };
    ctx.auth = {
      ...(ctx.auth ?? {}),
      impersonator,
      effective: { email: claim.email, layer: "impersonator" as const },
    };
    ctx.identity = claim.email;
    return { block: false, violations: [] };
  }

  private reject(reason: string): MiddlewareVerdict {
    const violation = {
      rule: "impersonator-verify-rejected",
      severity: "error" as const,
      message: `Impersonator verification failed: ${reason}`,
    };
    if (this.options.enforce === "warn") {
      return { block: false, violations: [{ ...violation, severity: "warning" }] };
    }
    return {
      block: true,
      violations: [violation],
      denial: {
        status: 401,
        error: "impersonator_verification_failed",
        // Generic message to the caller; the specific reason is in the
        // server-side violation record.
        message: "Impersonator verification failed.",
      },
    };
  }
}
