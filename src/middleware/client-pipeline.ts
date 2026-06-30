import type { ClientMiddleware, ClientMiddlewareContext } from "./types.ts";

/**
 * Runs every enabled client middleware against the outgoing request,
 * mutating `headers` in place.
 *
 * Semantics:
 * - Middlewares execute sequentially in the order they were registered.
 *   Earlier middlewares can set headers that later ones read (rare in
 *   practice, but supported).
 * - A middleware that throws aborts the whole pipeline. The thrown error
 *   bubbles up to the proxy, which translates it into a 502 — the upstream
 *   fetch never fires, so the client sees one clean error rather than a
 *   half-broken upstream call.
 */
export async function runClientPipeline(
  chain: ClientMiddleware[],
  headers: Headers,
  ctx: ClientMiddlewareContext,
): Promise<void> {
  for (const mw of chain) {
    await mw.apply(headers, ctx);
  }
}

/** Convenience: runs prepare() on every client middleware that has one. */
export async function prepareClientPipeline(chain: ClientMiddleware[]): Promise<void> {
  await Promise.all(chain.map((m) => m.prepare?.()));
}

/** Convenience: runs dispose() on every client middleware that has one. */
export async function disposeClientPipeline(chain: ClientMiddleware[]): Promise<void> {
  await Promise.all(chain.map((m) => m.dispose?.()));
}
