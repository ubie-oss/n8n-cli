/**
 * Header names shared between the CLI's API client and the `proxy` subcommand.
 *
 * These are proxy control headers, not n8n ones: the client sends them, the
 * proxy consumes them, and the proxy strips them before the call reaches n8n —
 * which has no idea they exist. Keeping the names here means the two ends
 * cannot drift apart.
 */

/**
 * Upstream `updatedAt` that the client's local definition was based on, sent
 * on workflow updates.
 *
 * The stale-write guard compares it against the stored workflow and rejects
 * the write when they differ: the caller is about to overwrite a state it has
 * never seen. Absent when the local definition carries no timestamp (a
 * hand-written file, or one imported before timestamps were persisted).
 */
export const BASE_UPDATED_AT_HEADER = "X-N8n-Base-Updated-At";

/** Set on a forwarded response when the stale-write guard runs in `warn` mode. */
export const STALE_WRITE_WARNING_HEADER = "X-N8n-Stale-Write-Warning";
