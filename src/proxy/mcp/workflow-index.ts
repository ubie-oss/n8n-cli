/**
 * Which workflows exist upstream, and which of them the MCP policy considers
 * agent-reachable.
 *
 * The decision needs the workflow's tags, and those are not in the MCP call —
 * only an id is. So the gate resolves them against the n8n public API and
 * caches the answer, the way the duplicate-name check does.
 *
 * Both sets matter. `allowed` answers "may this call proceed?"; `known` lets the
 * gate recognise a workflow id sitting in an argument it was not expecting, so
 * a tool whose parameter names this release guessed wrong still cannot reach a
 * workflow the policy excludes.
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

export interface WorkflowSets {
  /** Every workflow id upstream, whatever the policy says about it. */
  known: Set<string>;
  /** The subset the policy lets an agent reach. */
  allowed: Set<string>;
}

interface CacheEntry {
  sets: WorkflowSets;
  expiresAt: number;
}

export interface WorkflowIndexDeps {
  upstream: string;
  timeoutMs?: number;
  clientMiddlewares?: ClientMiddleware[];
}

export class AllowedWorkflowIndex {
  private cache: CacheEntry | null = null;
  /**
   * The fetch currently in flight, if any.
   *
   * Without it the startup prefetch and the first request that arrives while it
   * is still running would each walk the whole workflow list — doubling the
   * cost exactly when it is highest. Callers share one fetch instead.
   */
  private inFlight: Promise<WorkflowSets> | null = null;

  constructor(
    private readonly policy: McpPolicy,
    private readonly deps: WorkflowIndexDeps,
    private readonly ttlMs: number = 60_000,
  ) {}

  /** Drops the cache. Used by tests. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Starts filling the cache, without waiting for it.
   *
   * The listing walks every page of `/api/v1/workflows` with full node
   * payloads, which on an instance with thousands of workflows is seconds, not
   * milliseconds. Paying that inside the first `tools/call` puts it against the
   * caller's request budget — on Cloud Run with `min-scale: 0`, a per-cold-
   * start risk of timing out a call the policy meant to allow, and the gate
   * fails closed, so the caller sees a refusal rather than a slow success.
   *
   * Deliberately *not* awaited by the proxy's readiness pass. A deployment
   * whose startup probe reads `/readyz` would otherwise hold the container
   * back for as long as this takes, turning a slow n8n into a revision that
   * never starts — a worse failure than the one being avoided. Requests that
   * arrive meanwhile join the same fetch rather than starting their own.
   */
  prefetch(): void {
    void this.sets().catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`n8n-cli proxy: could not prefetch the MCP workflow index: ${reason}`);
    });
  }

  /**
   * The upstream workflow sets.
   *
   * Throws when the upstream cannot be read. The gate turns that into a refusal
   * — this class refuses to answer "allowed" from a list it never managed to
   * fetch.
   */
  async sets(): Promise<WorkflowSets> {
    if (!hasWorkflowScope(this.policy)) {
      return { known: new Set(), allowed: new Set() };
    }

    const now = performance.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.sets;
    if (this.inFlight) return this.inFlight;

    // A failed fetch is never cached as an answer — an empty allowlist would be
    // indistinguishable from "nothing is reachable", and the gate would keep
    // refusing every call for a full TTL after the upstream recovered. The
    // in-flight promise is cleared either way, so a failure is retried by the
    // next caller rather than remembered.
    this.inFlight = this.fetchSets()
      .then((sets) => {
        this.cache = { sets, expiresAt: performance.now() + this.ttlMs };
        return sets;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchSets(): Promise<WorkflowSets> {
    const known = new Set<string>();
    const allowed = new Set<string>();

    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${this.deps.upstream}/api/v1/workflows`);
      url.searchParams.set("limit", "100");
      // Only tags are read from the response. Pinned data can be the largest
      // part of a workflow and is never looked at here.
      url.searchParams.set("excludePinnedData", "true");
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
        known.add(workflow.id);
        if (this.matches(workflow)) allowed.add(workflow.id);
      }

      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    return { known, allowed };
  }

  private matches(workflow: Workflow): boolean {
    // The whole list is fetched rather than filtered with `?tags=`: n8n's tag
    // filter is an OR on some versions, and this has to be an AND.
    const present = new Set((workflow.tags ?? []).map((t) => t.name));
    return this.policy.workflowTags.every((t) => present.has(t));
  }
}
