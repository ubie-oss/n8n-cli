import type { Node, NodeConn, PinDataItem, Workflow, WorkflowSettings } from "../api/types.ts";
import { sortKeys } from "../formatter/workflow.ts";
import type { WorkflowDiff } from "./types.ts";

/** Compares local and remote workflows to detect differences. */
export function compare(local: Workflow, remote: Workflow): WorkflowDiff {
  const diff: WorkflowDiff = { hasChanges: false, fields: [] };

  if (local.name !== remote.name) {
    diff.fields.push({ field: "name", oldValue: remote.name, newValue: local.name });
    diff.hasChanges = true;
  }

  if (local.active !== remote.active) {
    diff.fields.push({ field: "active", oldValue: remote.active, newValue: local.active });
    diff.hasChanges = true;
  }

  if (!nodesEqual(local.nodes, remote.nodes)) {
    diff.fields.push({
      field: "nodes",
      oldValue: remote.nodes?.length ?? 0,
      newValue: local.nodes?.length ?? 0,
    });
    diff.hasChanges = true;
  }

  if (!connectionsEqual(local.connections, remote.connections)) {
    diff.fields.push({
      field: "connections",
      oldValue: countConnections(remote.connections),
      newValue: countConnections(local.connections),
    });
    diff.hasChanges = true;
  }

  if (!settingsEqual(local.settings, remote.settings)) {
    diff.fields.push({ field: "settings", oldValue: "modified", newValue: "changed" });
    diff.hasChanges = true;
  }

  if (!pinDataEqual(local.pinData, remote.pinData)) {
    diff.fields.push({
      field: "pinData",
      oldValue: remote.pinData ? Object.keys(remote.pinData).length : 0,
      newValue: local.pinData ? Object.keys(local.pinData).length : 0,
    });
    diff.hasChanges = true;
  }

  return diff;
}

/** Compares two slices of nodes for semantic equality. */
export function nodesEqual(local: Node[] | undefined, remote: Node[] | undefined): boolean {
  const a = local ?? [];
  const b = remote ?? [];
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;

  const aNorm = normalizeForComparison(a);
  const bNorm = normalizeForComparison(b);
  return deepEqual(aNorm, bNorm);
}

/** Compares two connection maps for semantic equality. */
export function connectionsEqual(
  local: Record<string, NodeConn> | undefined,
  remote: Record<string, NodeConn> | undefined,
): boolean {
  const a = local ?? {};
  const b = remote ?? {};
  if (Object.keys(a).length === 0 && Object.keys(b).length === 0) return true;
  if (Object.keys(a).length !== Object.keys(b).length) return false;

  const aNorm = normalizeForComparison(a);
  const bNorm = normalizeForComparison(b);
  return deepEqual(aNorm, bNorm);
}

/** Compares two workflow settings for equality. */
export function settingsEqual(
  local: WorkflowSettings | undefined,
  remote: WorkflowSettings | undefined,
): boolean {
  if (local == null && remote == null) return true;
  if (local == null || remote == null) return false;
  return deepEqual(local, remote);
}

/** Compares two pinData maps for semantic equality. */
export function pinDataEqual(
  local: Record<string, PinDataItem[]> | undefined,
  remote: Record<string, PinDataItem[]> | undefined,
): boolean {
  const a = local ?? {};
  const b = remote ?? {};
  if (Object.keys(a).length === 0 && Object.keys(b).length === 0) return true;
  if (Object.keys(a).length !== Object.keys(b).length) return false;

  const aNorm = normalizeForComparison(a);
  const bNorm = normalizeForComparison(b);
  return deepEqual(aNorm, bNorm);
}

/** Counts total connections in a connection map. */
function countConnections(connections: Record<string, NodeConn> | undefined): number {
  if (!connections) return 0;
  let count = 0;
  for (const nodeConn of Object.values(connections)) {
    if (nodeConn.main) {
      for (const conns of nodeConn.main) {
        count += conns.length;
      }
    }
  }
  return count;
}

/**
 * Normalizes data for semantic comparison.
 * Converts to JSON and back to normalize nil vs empty differences.
 */
export function normalizeForComparison(v: unknown): unknown {
  const json = JSON.stringify(v);
  const parsed = JSON.parse(json);
  return normalizeValue(parsed);
}

/**
 * Recursively normalizes nil/empty values.
 * Empty maps and slices are treated as equivalent.
 * Keys with empty values are removed (similar to omitempty behavior).
 */
export function normalizeValue(v: unknown): unknown {
  if (v == null) return null;

  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    let allEmpty = true;
    const result = v.map((item) => {
      const normalized = normalizeValue(item);
      if (!isEmpty(normalized)) allEmpty = false;
      return normalized;
    });
    return allEmpty ? [] : result;
  }

  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return {};

    const result: Record<string, unknown> = {};
    for (const k of keys) {
      const normalized = normalizeValue(obj[k]);
      if (!isEmpty(normalized)) {
        result[k] = normalized;
      }
    }
    return Object.keys(result).length === 0 ? {} : result;
  }

  return v;
}

/** Checks if a value is considered empty for comparison purposes. */
export function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Deep equality comparison using stable (key-sorted) JSON serialization. */
function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
