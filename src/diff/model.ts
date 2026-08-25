import type { Workflow } from "../api/types.ts";

/**
 * Structured diff model for workflow comparisons.
 *
 * The model is deliberately change-centric: it answers "what changed between
 * two states", not "show me two workflows". Runtime noise (node positions,
 * staticData) is excluded at the engine level so both humans and AI consumers
 * see only meaningful changes.
 */

/** Whether a discrete thing (node, edge) appeared or disappeared. */
export type ChangeKind = "added" | "removed";

/**
 * A single line in a line-level diff of multi-line code parameters.
 * `lineNumber` is 1-based within the side the line belongs to.
 */
export interface LineChange {
  kind: ChangeKind;
  lineNumber: number;
  text: string;
}

/**
 * A value-level change at a concrete path inside a workflow.
 *
 * For multi-line code-like values (Code node sources, SQL queries, ...) the
 * engine emits `lineChanges` instead of full before/after dumps, keeping the
 * output readable and token-efficient for AI consumers.
 */
export interface ValueChange {
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
  lineChanges?: LineChange[];
}

export type NodeDiffKind = "added" | "removed" | "renamed" | "modified";

export interface NodeDiff {
  kind: NodeDiffKind;
  nodeId?: string;
  /** Node name on the new side (the renamed-to name). */
  name: string;
  /** Present when the node was renamed. */
  oldName?: string;
  type: string;
  parameterChanges: ValueChange[];
  /** Changes outside `parameters`: typeVersion, credentials, onError, ... */
  otherChanges: ValueChange[];
  /**
   * The complete parameter object, present only on added/removed nodes —
   * the equivalent of git showing a whole new or deleted file. Renderers
   * expand it into all-added or all-removed diff rows.
   */
  fullParameters?: Record<string, unknown>;
}

export interface EdgeDiff {
  kind: ChangeKind;
  source: string;
  target: string;
  connectionType: string;
  sourceOutputIndex: number;
  targetInputIndex: number;
}

/** A node that did not change; carried so renderers can draw the full graph. */
export interface UnchangedNode {
  name: string;
  type: string;
}

/** An edge present on both sides; carried so renderers can draw the full graph. */
export interface EdgeRef {
  source: string;
  target: string;
  connectionType: string;
  sourceOutputIndex: number;
  targetInputIndex: number;
}

export type ComparisonStatus = "added" | "removed" | "modified" | "unchanged";

/**
 * One paired workflow in a report. `added` means present only on the right
 * (new/local) side, `removed` only on the left (old/remote) side.
 */
export interface WorkflowComparison {
  status: ComparisonStatus;
  workflowId?: string;
  name: string;
  leftSource?: string;
  rightSource?: string;
  detail?: WorkflowDiffDetail;
  /**
   * The raw left/right workflow objects, attached non-enumerably by
   * buildReport: renderers (the HTML raw JSON diff) use them in-process, but
   * they are excluded from `--format json` output to keep it token-efficient.
   */
  readonly leftRaw?: Workflow;
  readonly rightRaw?: Workflow;
}

export interface WorkflowDiffDetail {
  workflowId?: string;
  workflowName: string;
  /** Top-level identity/state fields: name, active, isArchived, description. */
  metadataChanges: ValueChange[];
  settingsChanges: ValueChange[];
  /** pinData is summarized as counts per node; contents are not dumped. */
  pinDataChanges: ValueChange[];
  nodeDiffs: NodeDiff[];
  edgeDiffs: EdgeDiff[];
  /** Nodes present on both sides with no change (rendering context). */
  unchangedNodes: UnchangedNode[];
  /** Edges present on both sides with no change (rendering context). */
  unchangedEdges: EdgeRef[];
}

export interface DiffReport {
  hasChanges: boolean;
  comparisons: WorkflowComparison[];
}

export interface DiffOptions {
  /**
   * Include node position changes. Off by default: dragging nodes around on
   * the canvas is noise that buries real changes.
   */
  includePosition?: boolean;
}
