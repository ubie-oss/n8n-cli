import { type CompiledJSONPath, compileJSONPath } from "@/middleware/jsonpath.ts";
import { expandRecord, expandTemplate } from "@/middleware/template.ts";
import type { GroupsRequestSpec } from "./types.ts";

/**
 * Optional injection point used in tests to swap out fetch without touching
 * global state. Production code uses globalThis.fetch.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GroupsResolverDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface CacheEntry {
  groups: string[];
  expiresAt: number;
}

/**
 * Resolves identity → list of group identifiers by calling the user-supplied
 * HTTP endpoint and applying a JSONPath extract to the response.
 *
 * Caches per identity to avoid hitting the groups API once per workflow in
 * a multi-workflow apply. TTL is configurable; pass cacheTtlMs=0 to disable.
 *
 * Errors propagate as thrown exceptions so the middleware can apply its
 * onError policy (deny|allow). The resolver itself has no policy view —
 * keeping the two concerns separate keeps the failure surface obvious.
 */
export class GroupsResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly path: CompiledJSONPath;
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(
    private readonly spec: GroupsRequestSpec,
    deps: GroupsResolverDeps = {},
  ) {
    this.path = compileJSONPath(spec.extract);
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => Date.now());
  }

  async resolve(identity: string): Promise<string[]> {
    const cached = this.cache.get(identity);
    if (cached && cached.expiresAt > this.now()) {
      return cached.groups;
    }

    const bindings = { env: this.env, identity };
    const url = expandTemplate(this.spec.url, bindings);
    const headers = expandRecord(this.spec.headers, bindings);
    const body =
      this.spec.body !== undefined ? expandTemplate(this.spec.body, bindings) : undefined;

    const init: RequestInit = { method: this.spec.method, headers };
    if (body !== undefined && this.spec.method !== "GET" && this.spec.method !== "HEAD") {
      init.body = body;
    }

    const controller = new AbortController();
    const timer =
      this.spec.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.spec.timeoutMs) : null;
    init.signal = controller.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`groups fetch failed: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`groups fetch returned HTTP ${response.status}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`groups response was not valid JSON: ${message}`);
    }

    const matches = this.path.evaluate(json);
    const groups: string[] = [];
    for (const m of matches) {
      if (typeof m === "string") groups.push(m);
    }

    if (this.spec.cacheTtlMs > 0) {
      this.cache.set(identity, {
        groups,
        expiresAt: this.now() + this.spec.cacheTtlMs,
      });
    }
    return groups;
  }

  /** Drops every cached entry. Exposed for tests. */
  clearCache(): void {
    this.cache.clear();
  }
}
