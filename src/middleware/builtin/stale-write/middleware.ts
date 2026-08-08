import { BASE_UPDATED_AT_HEADER } from "@/api/headers.ts";
import type {
  MiddlewareVerdict,
  ServerMiddleware,
  ServerMiddlewareContext,
} from "@/middleware/types.ts";
import type { StaleWriteOptions } from "./types.ts";

/** Violation rule name, also used by the proxy to recognise a warn-mode result. */
export const STALE_WRITE_RULE = "stale-write";

/**
 * Stale-write guard: rejects an update whose author never saw the state they
 * are about to overwrite.
 *
 * The failure it exists for is not a bad workflow — lint already catches those
 * — but a good one applied from an out-of-date checkout. Someone edits a
 * workflow in the n8n UI, nobody imports the change back into the repository,
 * and the next `apply` from any working copy silently reverts it. The write is
 * well-formed and authorized, so every other check waves it through.
 *
 * The caller states which upstream revision its definition was based on, via
 * the `X-N8n-Base-Updated-At` header. The guard reads the *stored* workflow and
 * compares. Equal means the caller is up to date; different means upstream
 * moved underneath them, and the write is refused with 409 so they can import
 * and re-apply.
 *
 * Deliberately uncached, unlike the duplicate-name check next to it: the whole
 * value of the read is that it reflects upstream *now*. A cache would let a
 * concurrent edit slip through the window it opens.
 *
 * Mismatch is judged in both directions. A base *newer* than what upstream
 * stores is not a safe write either — it means the caller's picture of the
 * workflow does not correspond to any state upstream currently has, most
 * likely because it was restored from a backup — so it is treated the same way.
 */
export class StaleWriteMiddleware implements ServerMiddleware {
  readonly name = "stale-write";
  /**
   * The verdict is about *when* the definition was written, not what is in it,
   * so this must keep running on routes that carry no workflow body.
   */
  readonly readsWorkflowBody = false;

  constructor(private readonly options: StaleWriteOptions) {}

  async evaluate(ctx: ServerMiddlewareContext): Promise<MiddlewareVerdict> {
    if (this.options.enforce === "off") return pass();

    // Apply mode has its own conflict detection against the same timestamps
    // and no HTTP request to read a header from. Nothing useful to add here.
    if (ctx.mode !== "proxy") return pass();

    const scoped = this.options.actions;
    if (scoped.length > 0 && (!ctx.action || !scoped.includes(ctx.action))) return pass();

    const id = ctx.workflowId;
    if (!id) return pass();

    const base = ctx.request?.headers.get(BASE_UPDATED_AT_HEADER)?.trim();
    if (!base) {
      if (this.options.onMissingBase === "allow") return pass();
      return this.deny(
        `Write declares no base revision (${BASE_UPDATED_AT_HEADER} header is absent). ` +
          "Re-import the workflow so the local definition records the revision it was written from.",
      );
    }

    if (!ctx.fetchStoredWorkflow) {
      return this.onReadFailure("this host provides no stored-workflow reader");
    }

    let storedUpdatedAt: string | undefined;
    try {
      const stored = await ctx.fetchStoredWorkflow(id);
      // No stored workflow means nothing can be reverted by this write.
      if (!stored) return pass();
      storedUpdatedAt = stored.updatedAt;
    } catch (err) {
      return this.onReadFailure(err instanceof Error ? err.message : String(err));
    }

    // Upstream does not expose a timestamp for this workflow, so the caller's
    // claim can be neither confirmed nor refuted. Blocking here would break
    // every write against such an instance.
    if (!storedUpdatedAt) return pass();

    if (sameInstant(base, storedUpdatedAt)) return pass();

    return this.deny(
      `Workflow ${id} was updated upstream at ${storedUpdatedAt}, but this write is based on ${base}. ` +
        "Applying it would revert changes the caller has never seen. Import the workflow and re-apply.",
    );
  }

  /** Read failures are a policy choice: fail closed by default. */
  private onReadFailure(reason: string): MiddlewareVerdict {
    if (this.options.onError === "allow") {
      return {
        block: false,
        violations: [
          {
            rule: `${STALE_WRITE_RULE}-warning`,
            severity: "warning",
            message: `Stored-state lookup failed (fail-open): ${reason}`,
          },
        ],
      };
    }
    return this.deny(`Stored-state lookup failed: ${reason}`);
  }

  private deny(message: string): MiddlewareVerdict {
    const violations = [{ rule: STALE_WRITE_RULE, severity: "error" as const, message }];
    if (this.options.enforce === "warn") {
      return { block: false, violations };
    }
    return {
      block: true,
      violations,
      denial: { status: 409, error: "workflow_stale_write", message },
    };
  }
}

function pass(): MiddlewareVerdict {
  return { block: false, violations: [] };
}

/**
 * Compares two timestamps as instants, falling back to an exact string match.
 *
 * Timestamps make a round trip through YAML, TypeScript and JSON before coming
 * back as a header, and formatting differences along the way (a dropped
 * trailing `Z`, `+00:00` for UTC) must not read as a conflict. Anything that
 * does not parse is compared verbatim, which is strict but never wrong.
 */
function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return left === right;
}
