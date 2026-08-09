/**
 * Which workflows the MCP policy considers agent-reachable.
 *
 * The decision needs the workflow's tags, name and settings, and none of those
 * are in the MCP call — only an id is. So the gate resolves them against the
 * n8n public API and caches the answer, the way the duplicate-name check does.
 *
 * The lookup goes through `forwardRequest`, not a bare fetch, because on a
 * deployment where the proxy holds the credentials (IAP id_token, shared API
 * key) the egress chain is the only thing that can authenticate it — an MCP
 * client sends a bearer token for the MCP endpoint and no `X-N8N-API-KEY` at
 * all.
 */

import type { Workflow } from "@/api/types.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";
import { forwardRequest } from "../upstream.ts";
import { hasWorkflowScope, type McpPolicy } from "./policy.ts";

/** Cap on pagination, matching the duplicate-name index. */
const MAX_PAGES = 50;

interface ListResponse {
  data?: Workflow[];
  nextCursor?: string | null;
}

interface CacheEntry {
  allowed: Set<string>;
  expiresAt: number;
}

export interface WorkflowIndexDeps {
  upstream: string;
  timeoutMs?: number;
  clientMiddlewares?: ClientMiddleware[];
}

export class AllowedWorkflowIndex {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly policy: McpPolicy,
    private readonly deps: WorkflowIndexDeps,
    private readonly ttlMs: number = 60_000,
  ) {}

  /** Drops the cache. Used by tests and after a policy-relevant write. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Whether the policy lets an agent reach this workflow.
   *
   * Throws when the upstream cannot be read. The caller decides what an
   * unreadable index means — this class refuses to answer "allowed" from a
   * list it never managed to fetch.
   */
  async isAllowed(id: string): Promise<boolean> {
    if (!hasWorkflowScope(this.policy)) return true;
    const allowed = await this.getIndex();
    return allowed.has(id);
  }

  private async getIndex(): Promise<Set<string>> {
    const now = performance.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.allowed;

    // A failed fetch is never cached as an answer — an empty allowlist would be
    // indistinguishable from "nothing is reachable", and the gate would keep
    // refusing every call for a full TTL after the upstream recovered. The
    // caller applies its own fail-open/closed policy to the throw instead.
    const allowed = await this.fetchAllowed();
    this.cache = { allowed, expiresAt: now + this.ttlMs };
    return allowed;
  }

  private async fetchAllowed(): Promise<Set<string>> {
    const allowed = new Set<string>();
    const namePattern = this.policy.workflowNamePattern
      ? new RegExp(this.policy.workflowNamePattern)
      : null;

    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${this.deps.upstream}/api/v1/workflows`);
      url.searchParams.set("limit", "100");
      // Ask n8n to narrow it where it can; the local check below is still the
      // authority, since `tags` is an OR on some versions and this must be AND.
      if (this.policy.workflowTags.length > 0) {
        url.searchParams.set("tags", this.policy.workflowTags.join(","));
      }
      if (cursor) url.searchParams.set("cursor", cursor);

      const { response } = await forwardRequest(
        new Request(url.toString(), {
          method: "GET",
          headers: new Headers({ accept: "application/json" }),
        }),
        this.deps.upstream,
        undefined,
        { timeoutMs: this.deps.timeoutMs, clientMiddlewares: this.deps.clientMiddlewares },
      );
      if (!response.ok) {
        throw new Error(`upstream returned HTTP ${response.status} listing workflows`);
      }

      const body = (await response.json()) as ListResponse;
      for (const workflow of body.data ?? []) {
        if (!workflow.id) continue;
        if (this.matches(workflow, namePattern)) allowed.add(workflow.id);
      }

      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    return allowed;
  }

  private matches(workflow: Workflow, namePattern: RegExp | null): boolean {
    if (this.policy.requireAvailableInMCP && workflow.settings?.availableInMCP !== true) {
      return false;
    }
    if (namePattern && !namePattern.test(workflow.name ?? "")) return false;
    if (this.policy.workflowTags.length > 0) {
      const present = new Set((workflow.tags ?? []).map((t) => t.name));
      if (!this.policy.workflowTags.every((t) => present.has(t))) return false;
    }
    return true;
  }
}
