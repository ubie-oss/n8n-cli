/**
 * Detects duplicate workflow names on the upstream n8n instance.
 *
 * Modeled after `src/apply/duplicate.ts` but adapted for the proxy's
 * request-scoped lifecycle: the upstream workflow list is cached with a TTL
 * so a chatty client doesn't trigger a `GET /workflows` for every POST.
 *
 * Each lookup uses the auth header from the inbound request — never a
 * proxy-wide credential — so duplicate detection respects the caller's own
 * permissions and never escalates privileges.
 */

interface UpstreamWorkflow {
  id?: string;
  name?: string;
  active?: boolean;
}

interface UpstreamListResponse {
  data?: UpstreamWorkflow[];
  nextCursor?: string | null;
}

export interface DuplicateMatch {
  id: string;
  active: boolean;
}

interface CacheEntry {
  byName: Map<string, DuplicateMatch[]>;
  expiresAt: number;
}

/**
 * TTL for cached upstream failures. Much shorter than the success TTL so a
 * single transient 401/5xx doesn't poison duplicate detection for a full
 * minute, but long enough that bursty requests under a permission outage
 * don't hammer the upstream.
 */
const FAILURE_TTL_MS = 5_000;

export class DuplicateChecker {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly upstreamBase: string,
    private readonly ttlMs: number = 60_000,
  ) {}

  /** Clears the cache. Mostly useful for tests. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Returns duplicate matches for the given name, or an empty array.
   *
   * Callers without an API key are skipped (`apiKey == null` returns `[]`)
   * rather than triggering an unauthenticated upstream call whose 401 would
   * poison the cache for every subsequent caller.
   *
   * @param apiKey The caller's `X-N8N-API-KEY` header value. Used as-is so
   *   the upstream query runs under the caller's permissions.
   */
  async findByName(name: string, apiKey: string | null): Promise<DuplicateMatch[]> {
    if (!name) return [];
    if (!apiKey) return [];
    const index = await this.getIndex(apiKey);
    return index.get(name) ?? [];
  }

  private async getIndex(apiKey: string): Promise<Map<string, DuplicateMatch[]>> {
    const now = performance.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.byName;
    }

    const result = await this.fetchWorkflowIndex(apiKey);
    const ttl = result.complete ? this.ttlMs : FAILURE_TTL_MS;
    this.cache = { byName: result.byName, expiresAt: now + ttl };
    return result.byName;
  }

  /**
   * Walks upstream pagination, returning the indexed names plus a `complete`
   * flag indicating whether every page succeeded. Partial / empty results
   * caused by an upstream error are returned as `complete: false` so the
   * caller can pick a short cache TTL and recover quickly.
   */
  private async fetchWorkflowIndex(
    apiKey: string,
  ): Promise<{ byName: Map<string, DuplicateMatch[]>; complete: boolean }> {
    const byName = new Map<string, DuplicateMatch[]>();
    let cursor: string | undefined;
    let pages = 0;

    // Hard cap pages to keep a misbehaving upstream from spinning the proxy.
    while (pages < 50) {
      pages++;
      const url = new URL(`${this.upstreamBase}/api/v1/workflows`);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-N8N-API-KEY": apiKey,
      };

      let res: Response;
      try {
        res = await fetch(url.toString(), { headers });
      } catch {
        return { byName, complete: false };
      }
      if (!res.ok) {
        return { byName, complete: false };
      }
      const body = (await res.json()) as UpstreamListResponse;
      const items = body.data ?? [];
      for (const wf of items) {
        if (!wf.name) continue;
        const list = byName.get(wf.name) ?? [];
        list.push({ id: wf.id ?? "", active: wf.active ?? false });
        byName.set(wf.name, list);
      }
      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }

    return { byName, complete: true };
  }
}
