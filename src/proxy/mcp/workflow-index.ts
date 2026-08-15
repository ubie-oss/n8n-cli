/**
 * What the gate knows about the workflows upstream.
 *
 * An MCP call carries a workflow id and nothing else, but the policy asks about
 * tags and about which trigger n8n would fire. So the gate resolves those from
 * the n8n public API and caches the answer, the way the duplicate-name check
 * does.
 *
 * Facts are kept per workflow rather than as a bare allow/deny set. Two reasons:
 * a refusal can then say *why* ("its entry trigger is a Schedule with no path")
 * instead of only "no", and a new predicate becomes a config change rather than
 * another round trip to n8n.
 *
 * The lookup goes through `forwardRequest`, not a bare fetch, because on a
 * deployment where the proxy holds the credentials (IAP id_token, shared API
 * key) the egress chain is the only thing that can authenticate it — an MCP
 * client sends a bearer token for the MCP endpoint and no `X-N8N-API-KEY` at
 * all.
 */

import type { Workflow } from "@/api/types.ts";
import { workflowProjectId } from "@/common/project-id.ts";
import type { ClientMiddleware } from "@/middleware/types.ts";
import { forwardRequest } from "../upstream.ts";
import {
  type EntryTrigger,
  findEntryTrigger,
  globMatch,
  hasWorkflowScope,
  type McpPolicy,
} from "./policy.ts";

/** Cap on pagination, matching the duplicate-name index. */
const MAX_PAGES = 50;

interface ListResponse {
  data?: Workflow[];
  nextCursor?: string | null;
}

/** What the gate remembers about one workflow. */
export interface WorkflowFacts {
  id: string;
  name: string;
  /**
   * Absent until {@link AllowedWorkflowIndex.fillDescription} asks for it: the
   * workflow listing does not carry descriptions, only the per-workflow read
   * does.
   */
  description?: string;
  /** Whether the per-workflow read has been attempted, successful or not. */
  descriptionFetched?: boolean;
  tags: string[];
  availableInMCP: boolean;
  /** The trigger n8n would start an MCP execution from, if any. */
  entry: EntryTrigger | null;
  /** Owning n8n project, when upstream includes shared metadata. */
  projectId: string;
}

export interface WorkflowSets {
  /** Facts for every workflow upstream, keyed by id. */
  facts: Map<string, WorkflowFacts>;
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

/** Why a workflow is not reachable, phrased for the agent that asked. */
export function explainRefusal(policy: McpPolicy, facts: WorkflowFacts | undefined): string {
  if (!facts) return "no workflow with that id is visible to this proxy";
  const reasons: string[] = [];
  if (policy.workflowTags.length > 0) {
    const missing = policy.workflowTags.filter((t) => !facts.tags.includes(t));
    if (missing.length > 0) reasons.push(`it does not carry the tag(s) ${missing.join(", ")}`);
  }
  if (policy.entryPathPattern !== undefined && !entryPathMatches(policy, facts)) {
    reasons.push(
      facts.entry === null
        ? "it has no trigger this proxy can enter it through"
        : facts.entry.path === undefined
          ? `its entry trigger "${facts.entry.name}" declares no path`
          : `its entry trigger path "${facts.entry.path}" is outside the agent-facing namespace`,
    );
  }
  return reasons.length > 0 ? reasons.join("; ") : "it is outside this proxy's MCP policy";
}

function entryPathMatches(policy: McpPolicy, facts: WorkflowFacts): boolean {
  if (policy.entryPathPattern === undefined) return true;
  if (!facts.entry?.path) return false;
  return globMatch(policy.entryPathPattern, facts.entry.path);
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
   * The upstream workflow facts.
   *
   * Throws when the upstream cannot be read. The gate turns that into a refusal
   * — this class refuses to answer "allowed" from a list it never managed to
   * fetch.
   */
  async sets(): Promise<WorkflowSets> {
    if (!hasWorkflowScope(this.policy)) {
      return { facts: new Map(), allowed: new Set() };
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

  /**
   * Fills in a workflow's description, which the listing does not carry.
   *
   * Measured against a live 2.32.5 instance: `GET /api/v1/workflows` answers
   * without a `description` field at all, while `GET /api/v1/workflows/{id}`
   * has it. So the index cannot know descriptions, and anything that needs one
   * has to ask per workflow — which is fine as long as it is only asked for a
   * workflow the policy already allows.
   *
   * Best effort. A workflow described without its description is still worth
   * returning; failing the whole call over it would trade the useful half for
   * nothing. Resolves once per workflow per cache lifetime, because the result
   * is written back onto the cached facts.
   */
  async fillDescription(facts: WorkflowFacts): Promise<void> {
    if (facts.description !== undefined || facts.descriptionFetched) return;
    facts.descriptionFetched = true;

    try {
      const url = new URL(
        `/api/v1/workflows/${encodeURIComponent(facts.id)}`,
        "http://mcp-gate.invalid",
      );
      url.searchParams.set("excludePinnedData", "true");
      const { response } = await forwardRequest(
        new Request(url.toString(), {
          method: "GET",
          headers: new Headers({ accept: "application/json" }),
        }),
        this.deps.upstream,
        undefined,
        { timeoutMs: this.deps.timeoutMs, clientMiddlewares: this.deps.clientMiddlewares },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { description?: unknown };
      if (typeof body.description === "string" && body.description !== "") {
        facts.description = body.description;
      }
    } catch {
      // Left without a description; see above.
    }
  }

  private async fetchSets(): Promise<WorkflowSets> {
    const facts = new Map<string, WorkflowFacts>();
    const allowed = new Set<string>();

    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Only the path and query are read from this URL — `forwardRequest`
      // prepends the upstream base itself. Building it from `upstream` would
      // double any base path an operator put in `--upstream`.
      const url = new URL("/api/v1/workflows", "http://mcp-gate.invalid");
      url.searchParams.set("limit", "100");
      // Only tags and trigger nodes are read from the response. Pinned data can
      // be the largest part of a workflow and is never looked at here.
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
        // 401/403 here is nearly always a missing credential rather than a
        // broken n8n: an MCP client authenticates to the MCP endpoint, so
        // nothing on the request carries an X-N8N-API-KEY unless the egress
        // chain supplies one. Say that, because the symptom otherwise is every
        // workflow-scoped call being refused with no clue why.
        const hint =
          response.status === 401 || response.status === 403
            ? " — the MCP gate reads the workflow list under the proxy's own credentials," +
              " so the client-middleware chain must supply one for /api/v1 (api-key-inject)"
            : "";
        throw new Error(`upstream returned HTTP ${response.status} listing workflows${hint}`);
      }

      const body = (await response.json()) as ListResponse;
      for (const workflow of body.data ?? []) {
        if (!workflow.id) continue;
        const f = toFacts(workflow);
        facts.set(f.id, f);
        if (this.matches(f)) allowed.add(f.id);
      }

      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    return { facts, allowed };
  }

  private matches(facts: WorkflowFacts): boolean {
    // The whole list is fetched rather than filtered with `?tags=`: n8n's tag
    // filter is an OR on some versions, and this has to be an AND.
    if (!this.policy.workflowTags.every((t) => facts.tags.includes(t))) return false;
    return entryPathMatches(this.policy, facts);
  }
}

function toFacts(workflow: Workflow): WorkflowFacts {
  return {
    id: workflow.id ?? "",
    name: workflow.name ?? "",
    ...(workflow.description ? { description: workflow.description } : {}),
    tags: (workflow.tags ?? []).map((t) => t.name),
    availableInMCP: workflow.settings?.availableInMCP === true,
    entry: findEntryTrigger(workflow.nodes),
    projectId: workflowProjectId(workflow),
  };
}
