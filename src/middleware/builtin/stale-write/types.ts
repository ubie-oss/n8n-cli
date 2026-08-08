/** How a stale write is surfaced. */
export type StaleWriteEnforce = "off" | "warn" | "error";

/** What to do when the caller declares no base state. */
export type StaleWriteOnMissingBase = "allow" | "deny";

/** What to do when the stored state cannot be read. */
export type StaleWriteOnError = "allow" | "deny";

export interface StaleWriteOptions {
  /** `off` skips the check, `warn` reports without blocking, `error` blocks. */
  enforce: StaleWriteEnforce;
  /**
   * Callers that send no base timestamp. `allow` (the default) is what lets
   * the guard be switched on in front of a mixed fleet — older CLI versions,
   * the n8n UI itself and raw API calls all write without one. `deny` closes
   * that gap once every writer is known to send it.
   */
  onMissingBase: StaleWriteOnMissingBase;
  /** Upstream read failures: `deny` refuses the write, `allow` lets it pass. */
  onError: StaleWriteOnError;
  /**
   * Routes the guard applies to. Defaults to `update` — the only operation
   * that can silently overwrite someone else's work. A `create` has no stored
   * state to be stale against.
   */
  actions: string[];
}
