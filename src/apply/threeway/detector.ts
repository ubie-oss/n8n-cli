import type { Node, NodeConn, Workflow, WorkflowSettings } from "../../api/types.ts";
import { normalizeForComparison } from "../differ.ts";
import type { ConflictResult, DiffVector } from "./types.ts";

/** Performs 3-way conflict detection between Base, Local, and Remote workflow states. */
export class ThreeWayDetector {
  /**
   * Detect performs 3-way conflict detection.
   *
   * Decision matrix:
   *  - Base == null: New file created locally -> create
   *  - Remote == null: Remote doesn't exist -> create
   *  - Base->Local no change, Base->Remote no change: skip
   *  - Base->Local changed, Base->Remote no change: update (safe)
   *  - Base->Local no change, Base->Remote changed: skip (no local changes)
   *  - Both changed, same content: update (converged)
   *  - Both changed, different content: conflict
   */
  detect(base: Workflow | null, local: Workflow, remote: Workflow | null): ConflictResult {
    if (base == null) {
      return {
        type: "create",
        reason: "new workflow (not found at base ref)",
      };
    }

    if (remote == null) {
      return {
        type: "create",
        reason: "workflow does not exist on remote server",
      };
    }

    const baseToLocal = this.compareWorkflows(local, base);
    const baseToRemote = this.compareWorkflows(remote, base);

    // `description` is judged on the base→local edge only, and never on
    // base→remote.
    //
    // `remote` comes from the n8n API while `base` is the definition at the git
    // base ref, so comparing them symmetrically means "this file predates
    // description support and someone wrote one in the UI" reads as a remote
    // change — and, paired with any local edit, as a conflict needing --force.
    // Nothing is at risk there: apply never sends a description the local file
    // does not declare (see `compare` in ../differ.ts), so a UI-authored one
    // cannot be clobbered and has nothing to conflict with.
    if (this.localChangedDescription(local, base)) {
      baseToLocal.changedFields.push("description");
      baseToLocal.hasChanges = true;
    }

    if (!baseToLocal.hasChanges && !baseToRemote.hasChanges) {
      return {
        type: "skip",
        reason: "no changes from base",
        baseToLocal,
        baseToRemote,
      };
    }

    if (baseToLocal.hasChanges && !baseToRemote.hasChanges) {
      return {
        type: "update",
        reason: "only local changed from base",
        baseToLocal,
        baseToRemote,
      };
    }

    if (!baseToLocal.hasChanges && baseToRemote.hasChanges) {
      return {
        type: "skip",
        reason: "only remote changed, no local changes to apply",
        baseToLocal,
        baseToRemote,
      };
    }

    // Both changed - check if converged (same final state)
    const localToRemote = this.compareWorkflows(local, remote);
    if (!localToRemote.hasChanges) {
      return {
        type: "update",
        reason: "converged (local and remote have same content)",
        baseToLocal,
        baseToRemote,
      };
    }

    return {
      type: "conflict",
      reason: "divergent changes (both local and remote changed differently from base)",
      baseToLocal,
      baseToRemote,
    };
  }

  /**
   * Whether the author changed the description in the definition itself.
   *
   * A local file with no `description` key is not claiming the description is
   * empty — it is not managing the field, which is every definition written
   * before n8n-cli could carry one. Same rule as the 2-way `compare`.
   */
  private localChangedDescription(local: Workflow, base: Workflow): boolean {
    if (local.description === undefined) return false;
    return local.description !== (base.description ?? "");
  }

  /** Compares two workflows and returns a DiffVector. */
  private compareWorkflows(a: Workflow, b: Workflow): DiffVector {
    const diff: DiffVector = { hasChanges: false, changedFields: [] };

    if (a.name !== b.name) {
      diff.changedFields.push("name");
      diff.hasChanges = true;
    }

    if (a.active !== b.active) {
      diff.changedFields.push("active");
      diff.hasChanges = true;
    }

    if (!this.nodesEqual(a.nodes, b.nodes)) {
      diff.changedFields.push("nodes");
      diff.hasChanges = true;
    }

    if (!this.connectionsEqual(a.connections, b.connections)) {
      diff.changedFields.push("connections");
      diff.hasChanges = true;
    }

    if (!this.settingsEqual(a.settings, b.settings)) {
      diff.changedFields.push("settings");
      diff.hasChanges = true;
    }

    // Note: pinData and updatedAt are intentionally NOT compared.
    // pinData cannot be synced via API. updatedAt is server-assigned.

    return diff;
  }

  private nodesEqual(a: Node[] | undefined, b: Node[] | undefined): boolean {
    const aArr = a ?? [];
    const bArr = b ?? [];
    if (aArr.length !== bArr.length) return false;
    if (aArr.length === 0) return true;
    const aNorm = normalizeForComparison(aArr);
    const bNorm = normalizeForComparison(bArr);
    return JSON.stringify(aNorm) === JSON.stringify(bNorm);
  }

  private connectionsEqual(
    a: Record<string, NodeConn> | undefined,
    b: Record<string, NodeConn> | undefined,
  ): boolean {
    const aObj = a ?? {};
    const bObj = b ?? {};
    if (Object.keys(aObj).length === 0 && Object.keys(bObj).length === 0) return true;
    if (Object.keys(aObj).length !== Object.keys(bObj).length) return false;
    const aNorm = normalizeForComparison(aObj);
    const bNorm = normalizeForComparison(bObj);
    return JSON.stringify(aNorm) === JSON.stringify(bNorm);
  }

  private settingsEqual(a: WorkflowSettings | undefined, b: WorkflowSettings | undefined): boolean {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
