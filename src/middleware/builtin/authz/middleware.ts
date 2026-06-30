import { resolveIdentity } from "@/middleware/identity.ts";
import type {
  MiddlewareVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";
import { GroupsResolver, type GroupsResolverDeps } from "./groups-resolver.ts";
import type { AuthzOptions } from "./types.ts";
import { WorkflowACLExtractor } from "./workflow-acl.ts";

/**
 * Authorization middleware: gates workflow writes based on whether the
 * actor's groups intersect with the workflow's allowed groups.
 *
 * Design note: identity may already be present on the ServerMiddlewareContext
 * when the pipeline runner resolved it upstream (proxy does this in one place
 * for every middleware). If not, the middleware re-resolves using its own
 * identity spec — this lets unit tests target the middleware in isolation
 * without standing up the pipeline.
 *
 * Denial response: 403 `workflow_authz_denied`, mirroring the lint
 * middleware's 422 shape so proxy clients can distinguish them by status
 * and `error` code.
 */
export class AuthzMiddleware implements ServerMiddleware {
  readonly name = "authz";
  private readonly resolver: GroupsResolver;
  private readonly acl: WorkflowACLExtractor;

  constructor(
    private readonly options: AuthzOptions,
    deps: GroupsResolverDeps = {},
  ) {
    this.resolver = new GroupsResolver(options.groups, deps);
    this.acl = new WorkflowACLExtractor(options.workflow);
  }

  async evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> {
    if (this.options.enforce === "off") {
      return { block: false, violations: [] };
    }

    const identity =
      ctx.identity ??
      resolveIdentity(this.options.identity, { request: ctx.request, env: process.env });

    const allowed = this.acl.extract(ctx.workflow);

    if (!identity) {
      return this.dispatchDenial(
        "authz-missing-identity",
        "Actor identity could not be resolved (header/env not present or claim missing)",
      );
    }
    if (allowed.length === 0) {
      return this.dispatchDenial(
        "authz-no-acl",
        "Workflow does not declare any allowed groups — refusing to allow edits via the gate",
      );
    }

    let groups: string[];
    try {
      groups = await this.resolver.resolve(identity);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.options.onError === "allow") {
        return {
          block: false,
          violations: [
            {
              rule: "authz-resolver-warning",
              severity: "warning",
              message: `Groups lookup failed (fail-open): ${message}`,
            },
          ],
        };
      }
      return this.dispatchDenial("authz-resolver-error", `Groups lookup failed: ${message}`);
    }

    const allowedSet = new Set(allowed);
    const intersect = groups.some((g) => allowedSet.has(g));
    if (intersect) {
      return { block: false, violations: [] };
    }

    return this.dispatchDenial(
      "authz-denied",
      `Identity "${identity}" is not in any of the workflow's allowed groups (${allowed.join(", ")})`,
    );
  }

  private dispatchDenial(rule: string, message: string): MiddlewareVerdict {
    const violations = [{ rule, severity: "error" as const, message }];
    if (this.options.enforce === "warn") {
      return { block: false, violations };
    }
    return {
      block: true,
      violations,
      denial: {
        status: 403,
        error: "workflow_authz_denied",
        message,
      },
    };
  }
}
