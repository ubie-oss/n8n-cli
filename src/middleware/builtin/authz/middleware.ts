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
  /**
   * Stored-ACL cache. Deliberately short-lived (`aclCacheTtlMs`): a cached ACL
   * is a cached permission, so this only exists to keep a multi-workflow apply
   * from re-reading the same workflow once per request.
   */
  private readonly aclCache = new Map<string, { acl: string[]; expiresAt: number }>();

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

    // Action scoping: when the operator named actions, stay out of the way on
    // every other route so something else (or nothing) governs those.
    const scoped = this.options.actions ?? [];
    if (scoped.length > 0 && ctx.action && !scoped.includes(ctx.action)) {
      return { block: false, violations: [] };
    }

    const identity =
      ctx.identity ??
      resolveIdentity(this.options.identity, { request: ctx.request, env: process.env });

    if (!identity) {
      return this.dispatchDenial(
        "authz-missing-identity",
        "Actor identity could not be resolved (header/env not present or claim missing)",
      );
    }

    let allowed: string[];
    try {
      allowed = await this.resolveAcl(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.options.onError === "allow") {
        return {
          block: false,
          violations: [
            {
              rule: "authz-acl-warning",
              severity: "warning",
              message: `ACL lookup failed (fail-open): ${message}`,
            },
          ],
        };
      }
      return this.dispatchDenial("authz-acl-error", `ACL lookup failed: ${message}`);
    }

    // Nothing to check against: every `create` lands here, and so does a
    // workflow nobody has labelled yet. `bootstrapGroups` decides by membership
    // when set; otherwise the blanket answer applies.
    if (allowed.length === 0) {
      const bootstrap = this.options.bootstrapGroups ?? [];
      if (bootstrap.length === 0) {
        if ((this.options.onMissingAcl ?? "deny") === "allow") {
          return { block: false, violations: [] };
        }
        return this.dispatchDenial(
          "authz-no-acl",
          "Workflow does not declare any allowed groups — refusing to allow edits via the gate",
        );
      }
      allowed = bootstrap;
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

  /**
   * Reads the ACL the decision is made against.
   *
   * With `aclSource: "upstream"` this is the *stored* workflow, never the
   * payload: an ACL the caller can rewrite in the same request grants nothing.
   * It is also the only source that works for an ACL kept in n8n tags, since
   * tags are assigned through a separate endpoint and never appear in a
   * workflow write body.
   *
   * A `create` has no stored state; it returns empty and the caller's
   * missing-ACL policy takes over.
   */
  private async resolveAcl(ctx: ServerMiddlewareContext): Promise<string[]> {
    if ((this.options.aclSource ?? "request") === "request") {
      return this.acl.extract(ctx.workflow);
    }
    const id = ctx.workflowId;
    if (!id) return [];
    if (!ctx.fetchStoredWorkflow) {
      throw new Error(
        "aclSource=upstream needs a stored-workflow reader, which this host did not provide",
      );
    }
    const ttl = this.options.aclCacheTtlMs ?? 10_000;
    const cached = this.aclCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.acl;

    const stored = await ctx.fetchStoredWorkflow(id);
    const acl = this.acl.extract(stored);
    if (ttl > 0) this.aclCache.set(id, { acl, expiresAt: Date.now() + ttl });
    return acl;
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
