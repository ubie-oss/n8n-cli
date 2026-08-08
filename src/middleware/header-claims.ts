/**
 * Which headers a client middleware supplies, and where.
 *
 * A claim says "the proxy provides this header's value on these paths; what the
 * caller sent for it is not the upstream's business". Two things read claims:
 * the registry refuses a chain in which two middlewares claim one header on
 * overlapping paths (the outcome would otherwise depend on chain order), and
 * `forwardRequest` discards the caller's `Authorization` on the paths where the
 * chain has claimed a credential header.
 *
 * Scope matters in both directions. Claiming globally what is really a
 * path-scoped injection would delete the caller's credential on paths the proxy
 * supplies nothing for; treating a path-scoped claim as global would also
 * reject configurations whose prefixes cannot collide.
 */
export interface HeaderClaim {
  /** Header name. Compared case-insensitively. */
  header: string;
  /**
   * Path prefix the claim covers. Absent means every path — the shape of a
   * middleware that writes its header on all upstream calls.
   */
  pathPrefix?: string;
}

function sameHeader(a: HeaderClaim, b: HeaderClaim): boolean {
  return a.header.toLowerCase() === b.header.toLowerCase();
}

/**
 * Whether two claims can ever apply to one request.
 *
 * Prefixes overlap when either covers everything or one is a prefix of the
 * other — `/webhook/` and `/webhook/a/` collide, `/webhook/a/` and
 * `/mcp-server/` cannot.
 */
export function claimsCollide(a: HeaderClaim, b: HeaderClaim): boolean {
  if (!sameHeader(a, b)) return false;
  if (a.pathPrefix === undefined || b.pathPrefix === undefined) return true;
  return a.pathPrefix.startsWith(b.pathPrefix) || b.pathPrefix.startsWith(a.pathPrefix);
}

/** Whether a claim applies to a concrete request path. */
export function claimCoversPath(claim: HeaderClaim, pathname: string): boolean {
  return claim.pathPrefix === undefined || pathname.startsWith(claim.pathPrefix);
}
