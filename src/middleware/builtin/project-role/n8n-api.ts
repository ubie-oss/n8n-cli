import type { ClientMiddleware } from "@/middleware/types.ts";
import { forwardRequest } from "@/proxy/upstream.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProjectMember {
  id: string;
  email: string;
  role: string | null;
}

export interface InstanceUser {
  id: string;
  email: string;
  role: string | null;
}

export interface N8nProjectApiDeps {
  upstream: string;
  clientMiddlewares?: ClientMiddleware[];
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface Paginated<T> {
  data: T[];
  nextCursor?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Reads n8n project membership and instance roles through the public API.
 *
 * Calls run under the proxy's own credentials (client middleware chain), not
 * the caller's API key — listing members requires `user:list` on a service key.
 */
export class N8nProjectApi {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly membersCache = new Map<string, CacheEntry<ProjectMember[]>>();
  private instanceUsersCache: CacheEntry<InstanceUser[]> | null = null;

  constructor(
    private readonly deps: N8nProjectApiDeps,
    private readonly membersCacheTtlMs: number,
    private readonly instanceRoleCacheTtlMs: number,
    now: () => number = () => Date.now(),
  ) {
    this.fetchImpl =
      deps.fetch ??
      ((input, init) =>
        forwardRequest(new Request(input, init), deps.upstream, undefined, {
          timeoutMs: deps.timeoutMs,
          clientMiddlewares: deps.clientMiddlewares,
        }).then((r) => r.response));
    this.now = now;
  }

  async projectRoleForEmail(projectId: string, email: string): Promise<string | null> {
    const members = await this.listProjectMembers(projectId);
    const normalized = email.trim().toLowerCase();
    const hit = members.find((m) => m.email.trim().toLowerCase() === normalized);
    return hit?.role ?? null;
  }

  async instanceRoleForEmail(email: string): Promise<string | null> {
    const users = await this.listInstanceUsers();
    const normalized = email.trim().toLowerCase();
    const hit = users.find((u) => u.email.trim().toLowerCase() === normalized);
    return hit?.role ?? null;
  }

  async listProjectMembers(projectId: string): Promise<ProjectMember[]> {
    const cached = this.membersCache.get(projectId);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const collected: ProjectMember[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.get(
        `/api/v1/projects/${encodeURIComponent(projectId)}/users?${query}`,
      );
      if (response.status === 404) {
        throw new Error(`project ${projectId} was not found upstream`);
      }
      if (!response.ok) {
        throw new Error(`project members lookup returned HTTP ${response.status}`);
      }
      const page = (await response.json()) as Paginated<Record<string, unknown>>;
      for (const row of page.data ?? []) {
        const id = typeof row.id === "string" ? row.id : "";
        const memberEmail = typeof row.email === "string" ? row.email : "";
        const role = typeof row.role === "string" ? row.role : null;
        if (id && memberEmail) collected.push({ id, email: memberEmail, role });
      }
      cursor =
        typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined;
    } while (cursor);

    if (this.membersCacheTtlMs > 0) {
      this.membersCache.set(projectId, {
        value: collected,
        expiresAt: this.now() + this.membersCacheTtlMs,
      });
    }
    return collected;
  }

  private async listInstanceUsers(): Promise<InstanceUser[]> {
    if (this.instanceUsersCache && this.instanceUsersCache.expiresAt > this.now()) {
      return this.instanceUsersCache.value;
    }

    const collected: InstanceUser[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", includeRole: "true" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.get(`/api/v1/users?${query}`);
      if (!response.ok) {
        throw new Error(`instance users lookup returned HTTP ${response.status}`);
      }
      const page = (await response.json()) as Paginated<Record<string, unknown>>;
      for (const row of page.data ?? []) {
        const id = typeof row.id === "string" ? row.id : "";
        const userEmail = typeof row.email === "string" ? row.email : "";
        const role = typeof row.role === "string" ? row.role : null;
        if (id && userEmail) collected.push({ id, email: userEmail, role });
      }
      cursor =
        typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined;
    } while (cursor);

    if (this.instanceRoleCacheTtlMs > 0) {
      this.instanceUsersCache = {
        value: collected,
        expiresAt: this.now() + this.instanceRoleCacheTtlMs,
      };
    }
    return collected;
  }

  private get(path: string): Promise<Response> {
    const url = `${this.deps.upstream}${path}`;
    return this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  }

  clearCache(): void {
    this.membersCache.clear();
    this.instanceUsersCache = null;
  }
}
