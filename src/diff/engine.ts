import type { Node, NodeConn, Workflow } from "../api/types.ts";
import { normalizeForComparison } from "../apply/differ.ts";
import type {
  DiffOptions,
  EdgeDiff,
  LineChange,
  NodeDiff,
  ValueChange,
  WorkflowDiffDetail,
} from "./model.ts";

/**
 * Node fields compared outside `parameters`. This is a whitelist: anything not
 * listed (and not `parameters`/`credentials`/`position`/`name`) is ignored, so
 * fields n8n adds for its own bookkeeping never show up as phantom changes.
 */
const NODE_SCALAR_FIELDS = [
  "type",
  "typeVersion",
  "webhookId",
  "onError",
  "retryOnFail",
  "maxTries",
  "waitBetweenTries",
  "alwaysOutputData",
  "executeOnce",
  "disabled",
  "notes",
  "notesInFlow",
] as const;

/**
 * Parameter keys whose values get line-level diffs instead of full before/
 * after dumps. Matched against the last path segment, case-insensitively.
 */
const CODE_KEY_PATTERN = /(code|jscode|query|sql|script|command)/i;

/** Above this size a line diff is O(n·m) memory — fall back to value dumps. */
const MAX_LINE_DIFF_LINES = 1000;

/**
 * differ.normalizeForComparison round-trips through JSON, so a top-level
 * `undefined` crashes it. Scalar node fields are optional and undefined is
 * their normal state — map it to null before normalization.
 */
function norm(v: unknown): unknown {
  return v === undefined ? null : normalizeForComparison(v);
}

export function compareWorkflows(
  oldWf: Workflow,
  newWf: Workflow,
  opts: DiffOptions = {},
): WorkflowDiffDetail {
  const detail: WorkflowDiffDetail = {
    workflowId: newWf.id ?? oldWf.id,
    workflowName: newWf.name || oldWf.name,
    metadataChanges: [],
    settingsChanges: [],
    pinDataChanges: [],
    nodeDiffs: [],
    edgeDiffs: [],
  };

  diffMetadata(oldWf, newWf, detail);
  diffSettings(oldWf.settings, newWf.settings, detail);
  diffPinData(oldWf.pinData, newWf.pinData, detail);

  const match = matchNodes(oldWf.nodes ?? [], newWf.nodes ?? [], opts);
  detail.nodeDiffs = buildNodeDiffs(match, opts);

  const nameMap = buildNameCanonMap(match, oldWf.nodes ?? [], newWf.nodes ?? []);
  detail.edgeDiffs = diffEdges(oldWf.connections, newWf.connections, nameMap);

  return detail;
}

/** True when a detail carries no observable change. */
export function isDetailEmpty(detail: WorkflowDiffDetail): boolean {
  return (
    detail.metadataChanges.length === 0 &&
    detail.settingsChanges.length === 0 &&
    detail.pinDataChanges.length === 0 &&
    detail.nodeDiffs.length === 0 &&
    detail.edgeDiffs.length === 0
  );
}

// ---------------------------------------------------------------------------
// Metadata / settings / pinData
// ---------------------------------------------------------------------------

function diffMetadata(oldWf: Workflow, newWf: Workflow, detail: WorkflowDiffDetail): void {
  // A missing description and an empty one mean the same thing to every
  // consumer of this diff; comparing them literally would report changes that
  // apply itself treats as unmanaged.
  pushIfChanged(detail.metadataChanges, "name", oldWf.name, newWf.name);
  pushIfChanged(detail.metadataChanges, "active", oldWf.active, newWf.active);
  pushIfChanged(
    detail.metadataChanges,
    "isArchived",
    oldWf.isArchived ?? false,
    newWf.isArchived ?? false,
  );
  pushIfChanged(
    detail.metadataChanges,
    "description",
    oldWf.description ?? "",
    newWf.description ?? "",
  );
}

function diffSettings(
  oldS: Workflow["settings"],
  newS: Workflow["settings"],
  detail: WorkflowDiffDetail,
): void {
  detail.settingsChanges = diffValues(
    normalizeForComparison(oldS ?? {}),
    normalizeForComparison(newS ?? {}),
    "settings",
  );
}

function diffPinData(
  oldP: Workflow["pinData"],
  newP: Workflow["pinData"],
  detail: WorkflowDiffDetail,
): void {
  const oldCount = countPinNodes(oldP);
  const newCount = countPinNodes(newP);
  if (oldCount !== newCount) {
    detail.pinDataChanges.push({
      path: "pinData",
      oldValue: `${oldCount} nodes`,
      newValue: `${newCount} nodes`,
    });
  }
}

function countPinNodes(p: Workflow["pinData"]): number {
  return p ? Object.keys(p).length : 0;
}

function pushIfChanged(
  changes: ValueChange[],
  path: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  if (!deepEqual(oldValue, newValue)) {
    changes.push({ path, oldValue, newValue });
  }
}

// ---------------------------------------------------------------------------
// Node matching
// ---------------------------------------------------------------------------

interface NodeMatch {
  /** The two arrays the indexes below refer to. */
  oldNodes: Node[];
  newNodes: Node[];
  /** Pairs of indexes into (oldNodes, newNodes). */
  pairs: Array<{ oldIdx: number; newIdx: number }>;
  addedNewIdx: number[];
  removedOldIdx: number[];
}

function matchNodes(oldNodes: Node[], newNodes: Node[], opts: DiffOptions): NodeMatch {
  const match: NodeMatch = { oldNodes, newNodes, pairs: [], addedNewIdx: [], removedOldIdx: [] };
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();

  // Pass 1: stable node IDs. n8n mints these once at creation time.
  const newById = new Map<string, number>();
  newNodes.forEach((n, i) => {
    if (n.id != null) newById.set(n.id, i);
  });

  oldNodes.forEach((old, oi) => {
    if (old.id == null) return;
    const ni = newById.get(old.id);
    if (ni !== undefined && !usedNew.has(ni)) {
      match.pairs.push({ oldIdx: oi, newIdx: ni });
      usedOld.add(oi);
      usedNew.add(ni);
    }
  });

  // Pass 2: exact name. Catches imports where IDs were regenerated but names
  // survived, and keeps renames from cascading into remove+add noise.
  const newByName = new Map<string, number>();
  newNodes.forEach((n, i) => {
    if (!usedNew.has(i)) newByName.set(n.name, i);
  });
  oldNodes.forEach((old, oi) => {
    if (usedOld.has(oi)) return;
    const ni = newByName.get(old.name);
    if (ni !== undefined) {
      match.pairs.push({ oldIdx: oi, newIdx: ni });
      usedOld.add(oi);
      usedNew.add(ni);
    }
  });

  // Pass 3: rename heuristic. `.ts` workflows derive node IDs from the node
  // name (see ts/node-ids.ts), so renaming a node changes both its ID and its
  // name. What survives is type + parameters: pair leftovers of the same type
  // whose significant content is identical.
  const leftoverNewByType = new Map<string, number[]>();
  newNodes.forEach((n, i) => {
    if (!usedNew.has(i)) {
      const list = leftoverNewByType.get(n.type) ?? [];
      list.push(i);
      leftoverNewByType.set(n.type, list);
    }
  });
  oldNodes.forEach((old, oi) => {
    if (usedOld.has(oi)) return;
    const candidates = leftoverNewByType.get(old.type);
    if (!candidates || candidates.length === 0) return;
    for (let k = 0; k < candidates.length; k++) {
      const ni = candidates[k]!;
      if (significantEqual(old, newNodes[ni]!, opts)) {
        match.pairs.push({ oldIdx: oi, newIdx: ni });
        usedOld.add(oi);
        usedNew.add(ni);
        candidates.splice(k, 1);
        break;
      }
    }
  });

  // Pass 4: similar-content renames. A node that was both renamed and edited
  // no longer matches pass 3 exactly; pairing leftovers of the same type whose
  // parameter paths overlap enough beats reporting a confusing remove+add.
  const leftoverOld: number[] = [];
  oldNodes.forEach((_, oi) => {
    if (!usedOld.has(oi)) leftoverOld.push(oi);
  });
  for (const oi of leftoverOld) {
    const old = oldNodes[oi]!;
    let bestNi = -1;
    let bestScore = RENAME_SIMILARITY_THRESHOLD;
    newNodes.forEach((n, ni) => {
      if (usedNew.has(ni) || n.type !== old.type) return;
      const score = similarity(old, n, opts);
      if (score >= bestScore) {
        bestScore = score;
        bestNi = ni;
      }
    });
    if (bestNi !== -1) {
      match.pairs.push({ oldIdx: oi, newIdx: bestNi });
      usedOld.add(oi);
      usedNew.add(bestNi);
    }
  }

  oldNodes.forEach((_, oi) => {
    if (!usedOld.has(oi)) match.removedOldIdx.push(oi);
  });
  newNodes.forEach((_, ni) => {
    if (!usedNew.has(ni)) match.addedNewIdx.push(ni);
  });

  return match;
}

/** Compares everything except the name — the fingerprint used by pass 3. */
function significantEqual(a: Node, b: Node, opts: DiffOptions): boolean {
  if (a.type !== b.type) return false;
  return deepEqual(significantView(a, opts), significantView(b, opts));
}

/**
 * Minimum fraction of shared parameter paths for pass 4 to call two leftover
 * same-type nodes a rename. 0.5 means "at least half the parameter paths
 * survive", which separates an edited node from an unrelated replacement.
 */
const RENAME_SIMILARITY_THRESHOLD = 0.5;

function similarity(a: Node, b: Node, opts: DiffOptions): number {
  const viewA = flattenPaths(significantView(a, opts));
  const viewB = flattenPaths(significantView(b, opts));
  const max = Math.max(viewA.size, viewB.size);
  if (max === 0) return deepEqual(significantView(a, opts), significantView(b, opts)) ? 1 : 0;
  let shared = 0;
  for (const p of viewA) {
    if (viewB.has(p)) shared++;
  }
  return shared / max;
}

/** Flattens a value into leaf "path=value" strings for similarity scoring. */
function flattenPaths(v: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      for (const p of flattenPaths(item, `${prefix}[${i}]`)) out.add(p);
    });
    return out;
  }
  if (v != null && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      for (const p of flattenPaths(val, `${prefix}.${k}`)) out.add(p);
    }
    return out;
  }
  // Long code bodies are compared by shape, not by content: every line would
  // otherwise count against similarity after any edit.
  const leaf =
    typeof v === "string" && v.length > 80 ? `<${v.split("\n").length} lines>` : String(v);
  out.add(`${prefix}=${leaf}`);
  return out;
}

function significantView(node: Node, opts: DiffOptions): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of NODE_SCALAR_FIELDS) {
    view[field] = (node as unknown as Record<string, unknown>)[field];
  }
  view.parameters = normalizeForComparison(node.parameters ?? {});
  view.credentials = normalizeForComparison(node.credentials ?? {});
  if (opts.includePosition) view.position = node.position;
  return view;
}

// ---------------------------------------------------------------------------
// Node diffs
// ---------------------------------------------------------------------------

function buildNodeDiffs(match: NodeMatch, opts: DiffOptions): NodeDiff[] {
  const diffs: NodeDiff[] = [];

  for (const { oldIdx, newIdx } of match.pairs) {
    const oldNode = match.oldNodes[oldIdx]!;
    const newNode = match.newNodes[newIdx]!;
    const nd = diffPairedNode(oldNode, newNode, opts);
    if (nd) diffs.push(nd);
  }
  for (const ni of match.addedNewIdx) {
    const node = match.newNodes[ni]!;
    diffs.push({
      kind: "added",
      nodeId: node.id,
      name: node.name,
      type: node.type,
      parameterChanges: [],
      otherChanges: [],
    });
  }
  for (const oi of match.removedOldIdx) {
    const node = match.oldNodes[oi]!;
    diffs.push({
      kind: "removed",
      nodeId: node.id,
      name: node.name,
      type: node.type,
      parameterChanges: [],
      otherChanges: [],
    });
  }
  return diffs;
}

/** Returns null when the paired nodes are semantically identical. */
function diffPairedNode(oldNode: Node, newNode: Node, opts: DiffOptions): NodeDiff | null {
  const parameterChanges = diffParams(
    normalizeForComparison(oldNode.parameters ?? {}),
    normalizeForComparison(newNode.parameters ?? {}),
  );

  const otherChanges: ValueChange[] = [];
  for (const field of NODE_SCALAR_FIELDS) {
    const ov = (oldNode as unknown as Record<string, unknown>)[field];
    const nv = (newNode as unknown as Record<string, unknown>)[field];
    pushIfChanged(otherChanges, field, norm(ov), norm(nv));
  }
  const credChanges = diffValues(
    normalizeForComparison(oldNode.credentials ?? {}),
    normalizeForComparison(newNode.credentials ?? {}),
    "credentials",
  );
  otherChanges.push(...credChanges);

  if (opts.includePosition && !deepEqual(oldNode.position ?? [], newNode.position ?? [])) {
    otherChanges.push({
      path: "position",
      oldValue: oldNode.position,
      newValue: newNode.position,
    });
  }

  const renamed = oldNode.name !== newNode.name;
  if (parameterChanges.length === 0 && otherChanges.length === 0) {
    if (!renamed) return null;
    return {
      kind: "renamed",
      nodeId: newNode.id ?? oldNode.id,
      name: newNode.name,
      oldName: oldNode.name,
      type: newNode.type,
      parameterChanges,
      otherChanges,
    };
  }

  // A rename that carries content changes is reported as a modification with
  // the old name attached — the rename alone would hide the real edit.
  return {
    kind: "modified",
    nodeId: newNode.id ?? oldNode.id,
    name: newNode.name,
    oldName: renamed ? oldNode.name : undefined,
    type: newNode.type,
    parameterChanges,
    otherChanges,
  };
}

// ---------------------------------------------------------------------------
// Generic recursive value diff
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function diffValues(oldV: unknown, newV: unknown, prefix: string): ValueChange[] {
  const changes: ValueChange[] = [];
  collectChanges(oldV, newV, prefix, changes);
  return changes;
}

function collectChanges(oldV: unknown, newV: unknown, path: string, out: ValueChange[]): void {
  // When exactly one side is a plain object and the other is missing, recurse
  // into the present side so additions and removals are reported per leaf
  // instead of as one opaque subtree swap.
  if (oldV === undefined && isPlainObject(newV)) oldV = {};
  if (newV === undefined && isPlainObject(oldV)) newV = {};

  if (
    typeof oldV === "object" &&
    typeof newV === "object" &&
    oldV !== null &&
    newV !== null &&
    !Array.isArray(oldV) &&
    !Array.isArray(newV)
  ) {
    const o = oldV as Record<string, unknown>;
    const n = newV as Record<string, unknown>;
    const keys = new Set([...Object.keys(o), ...Object.keys(n)]);
    for (const key of [...keys].sort()) {
      collectChanges(o[key], n[key], `${path}.${key}`, out);
    }
    return;
  }

  if (deepEqual(oldV, newV)) return;

  const lastKey = path.split(".").pop() ?? "";
  if (typeof oldV === "string" && typeof newV === "string" && CODE_KEY_PATTERN.test(lastKey)) {
    const lines = diffLines(oldV, newV);
    if (lines) {
      out.push({ path, lineChanges: lines });
      return;
    }
  }

  out.push({ path, oldValue: truncateOutputValue(oldV), newValue: truncateOutputValue(newV) });
}

/** Keeps single-line previews bounded so one huge parameter cannot flood output. */
function truncateOutputValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v.length <= 200 || v.includes("\n")) return v;
  return `${v.slice(0, 197)}...`;
}

// ---------------------------------------------------------------------------
// Parameters (top-level object wrapper around diffValues with code detection)
// ---------------------------------------------------------------------------

function diffParams(oldP: unknown, newP: unknown): ValueChange[] {
  return diffValues(oldP ?? {}, newP ?? {}, "parameters");
}

// ---------------------------------------------------------------------------
// Line diff (LCS-based)
// ---------------------------------------------------------------------------

export function diffLines(oldText: string, newText: string): LineChange[] | null {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length > MAX_LINE_DIFF_LINES || newLines.length > MAX_LINE_DIFF_LINES) {
    return null;
  }

  const lcs = lcsLengths(oldLines, newLines);
  const changes: LineChange[] = [];
  backtrack(lcs, oldLines, newLines, changes);
  return changes;
}

function lcsLengths(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
    }
  }
  return table;
}

function backtrack(table: Uint32Array, a: string[], b: string[], out: LineChange[]): void {
  const width = b.length + 1;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const down = table[(i + 1) * width + j] ?? 0;
    const right = table[i * width + (j + 1)] ?? 0;
    if (down >= right) {
      out.push({ kind: "removed", lineNumber: i + 1, text: a[i]! });
      i++;
    } else {
      out.push({ kind: "added", lineNumber: j + 1, text: b[j]! });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", lineNumber: i + 1, text: a[i]! });
    i++;
  }
  while (j < b.length) {
    out.push({ kind: "added", lineNumber: j + 1, text: b[j]! });
    j++;
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * Builds old-name → canonical-name mapping. Canonical names use the NEW side's
 * name for matched nodes, so a rename does not masquerade as rewiring.
 */
function buildNameCanonMap(
  match: NodeMatch,
  oldNodes: Node[],
  newNodes: Node[],
): { oldToCanon: Map<string, string>; newToCanon: Map<string, string> } {
  const oldToCanon = new Map<string, string>();
  const newToCanon = new Map<string, string>();

  for (const { oldIdx, newIdx } of match.pairs) {
    const canon = newNodes[newIdx]!.name;
    oldToCanon.set(oldNodes[oldIdx]!.name, canon);
    newToCanon.set(newNodes[newIdx]!.name, canon);
  }
  for (const oi of match.removedOldIdx) {
    const n = oldNodes[oi]!;
    oldToCanon.set(n.name, `gone:${n.name}`);
  }
  for (const ni of match.addedNewIdx) {
    const n = newNodes[ni]!;
    newToCanon.set(n.name, `new:${n.name}`);
  }

  return { oldToCanon, newToCanon };
}

interface RawEdge {
  connectionType: string;
  sourceOutputIndex: number;
  targetInputIndex: number;
  source: string;
  target: string;
}

function extractEdges(connections: Record<string, NodeConn> | undefined): RawEdge[] {
  const edges: RawEdge[] = [];
  if (!connections) return edges;

  for (const [sourceName, nodeConn] of Object.entries(connections)) {
    if (!nodeConn) continue;
    for (const [connType, outputs] of Object.entries(nodeConn)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((targets, outIdx) => {
        if (!Array.isArray(targets)) return;
        for (const conn of targets) {
          edges.push({
            connectionType: connType,
            sourceOutputIndex: outIdx,
            targetInputIndex: conn.index ?? 0,
            source: sourceName,
            target: conn.node,
          });
        }
      });
    }
  }
  return edges;
}

function edgeKey(e: RawEdge): string {
  return `${e.connectionType}[${e.sourceOutputIndex}] ${e.source} -> ${e.target} [${e.targetInputIndex}]`;
}

function diffEdges(
  oldConns: Workflow["connections"],
  newConns: Workflow["connections"],
  maps: { oldToCanon: Map<string, string>; newToCanon: Map<string, string> },
): EdgeDiff[] {
  const oldEdges = extractEdges(oldConns).map((e) => ({
    ...e,
    source: maps.oldToCanon.get(e.source) ?? e.source,
    target: maps.oldToCanon.get(e.target) ?? e.target,
  }));
  const newEdges = extractEdges(newConns).map((e) => ({
    ...e,
    source: maps.newToCanon.get(e.source) ?? e.source,
    target: maps.newToCanon.get(e.target) ?? e.target,
  }));

  const oldKeys = new Map<string, RawEdge>();
  for (const e of oldEdges) oldKeys.set(edgeKey(e), e);
  const newKeys = new Map<string, RawEdge>();
  for (const e of newEdges) newKeys.set(edgeKey(e), e);

  const diffs: EdgeDiff[] = [];
  for (const [key, e] of newKeys) {
    if (!oldKeys.has(key)) {
      diffs.push(toEdgeDiff("added", e));
    }
  }
  for (const [key, e] of oldKeys) {
    if (!newKeys.has(key)) {
      diffs.push(toEdgeDiff("removed", e));
    }
  }
  diffs.sort(compareEdgeDiffs);
  return diffs;
}

function toEdgeDiff(kind: EdgeDiff["kind"], e: RawEdge): EdgeDiff {
  return {
    kind,
    source: stripMarker(e.source),
    target: stripMarker(e.target),
    connectionType: e.connectionType,
    sourceOutputIndex: e.sourceOutputIndex,
    targetInputIndex: e.targetInputIndex,
  };
}

/** Drops the gone:/new: markers used only for key uniqueness during comparison. */
function stripMarker(name: string): string {
  if (name.startsWith("gone:")) return name.slice("gone:".length);
  if (name.startsWith("new:")) return name.slice("new:".length);
  return name;
}

function compareEdgeDiffs(a: EdgeDiff, b: EdgeDiff): number {
  return (
    a.source.localeCompare(b.source) ||
    a.connectionType.localeCompare(b.connectionType) ||
    a.sourceOutputIndex - b.sourceOutputIndex ||
    a.target.localeCompare(b.target)
  );
}

// ---------------------------------------------------------------------------
// Equality helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v != null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
