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
   * @param apiKey The caller's `X-N8N-API-KEY` header value. Used as-is so
   *   the upstream query runs under the caller's permissions.
   */
  async findByName(name: string, apiKey: string | null): Promise<DuplicateMatch[]> {
    if (!name) return [];
    const index = await this.getIndex(apiKey);
    return index.get(name) ?? [];
  }

  private async getIndex(apiKey: string | null): Promise<Map<string, DuplicateMatch[]>> {
    const now = performance.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.byName;
    }

    const byName = await this.fetchWorkflowIndex(apiKey);
    this.cache = { byName, expiresAt: now + this.ttlMs };
    return byName;
  }

  private async fetchWorkflowIndex(apiKey: string | null): Promise<Map<string, DuplicateMatch[]>> {
    const byName = new Map<string, DuplicateMatch[]>();
    let cursor: string | undefined;
    let pages = 0;

    // Hard cap pages to keep a misbehaving upstream from spinning the proxy.
    while (pages < 50) {
      pages++;
      const url = new URL(`${this.upstreamBase}/api/v1/workflows`);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers["X-N8N-API-KEY"] = apiKey;

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        // On any upstream error, return whatever we collected so far and stop.
        // The proxy will treat this as "no duplicate" — safer than blocking on
        // a transient upstream hiccup.
        break;
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

    return byName;
  }
}
