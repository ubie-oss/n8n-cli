import type {
  DiffReport,
  NodeDiff,
  ValueChange,
  WorkflowComparison,
  WorkflowDiffDetail,
} from "./model.ts";

/**
 * Human-readable text rendering. Change-centric: a summary line per workflow
 * first, then per-node detail only for workflows that actually changed.
 */
export function formatDiffText(report: DiffReport, statOnly = false): string {
  const lines: string[] = [];

  if (!report.hasChanges) {
    return "No differences found.\n";
  }

  for (const c of report.comparisons) {
    lines.push(...comparisonSummaryLines(c));
  }

  if (!statOnly) {
    for (const c of report.comparisons) {
      if (c.status !== "modified" || !c.detail) continue;
      lines.push("");
      lines.push(`=== ${c.name}${c.workflowId ? ` (id: ${c.workflowId})` : ""} ===`);
      lines.push(...formatDetailLines(c.detail));
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Compact per-workflow summary lines only — no detail blocks. */
export function formatDiffStat(report: DiffReport): string {
  if (!report.hasChanges) return "No differences found.\n";
  const lines = report.comparisons.flatMap(comparisonSummaryLines);
  return `${lines.join("\n")}\n`;
}

function comparisonSummaryLines(c: WorkflowComparison): string[] {
  const id = c.workflowId ? ` (id: ${c.workflowId})` : "";
  switch (c.status) {
    case "unchanged":
      return [`= ${c.name}${id} (no changes)`];
    case "added":
      return [`+ ${c.name}${id} [new on right side${c.rightSource ? `: ${c.rightSource}` : ""}]`];
    case "removed":
      return [`- ${c.name}${id} [only on left side${c.leftSource ? `: ${c.leftSource}` : ""}]`];
    case "modified": {
      const d = c.detail!;
      const parts: string[] = [];
      const counts = countNodeKinds(d.nodeDiffs);
      if (counts.added) parts.push(`+${counts.added} nodes`);
      if (counts.removed) parts.push(`-${counts.removed} nodes`);
      if (counts.modified) parts.push(`~${counts.modified} nodes`);
      if (counts.renamed) parts.push(`~${counts.renamed} renamed`);
      if (d.edgeDiffs.length > 0) parts.push(`~connections (${d.edgeDiffs.length})`);
      if (parts.length === 0 && d.metadataChanges.length > 0) parts.push("metadata");
      if (parts.length === 0 && d.settingsChanges.length > 0) parts.push("settings");
      if (parts.length === 0 && d.pinDataChanges.length > 0) parts.push("pinData");
      return [`M ${c.name}${id}  ${parts.join(", ")}`];
    }
  }
}

function countNodeKinds(diffs: NodeDiff[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of diffs) {
    counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Renders one workflow's detail as indented lines. Shared between the diff
 * command output and apply's update section, so both surfaces stay consistent.
 */
export function formatDetailLines(detail: WorkflowDiffDetail): string[] {
  const lines: string[] = [];

  if (detail.metadataChanges.length > 0) {
    lines.push("  Metadata:");
    for (const c of detail.metadataChanges) {
      lines.push(...indent(valueChangeLines(c), "    "));
    }
  }

  if (detail.nodeDiffs.length > 0) {
    lines.push("  Nodes:");
    for (const nd of detail.nodeDiffs) {
      lines.push(...nodeDiffLines(nd).map((l) => `    ${l}`));
    }
  }

  if (detail.edgeDiffs.length > 0) {
    lines.push("  Connections:");
    for (const e of detail.edgeDiffs) {
      const sign = e.kind === "added" ? "+" : "-";
      lines.push(
        `    ${sign} "${e.source}" →[${e.connectionType}:${e.sourceOutputIndex}] "${e.target}"`,
      );
    }
  }

  if (detail.settingsChanges.length > 0) {
    lines.push("  Settings:");
    for (const c of detail.settingsChanges) {
      lines.push(...indent(valueChangeLines(c), "    "));
    }
  }

  if (detail.pinDataChanges.length > 0) {
    for (const c of detail.pinDataChanges) {
      lines.push(...indent(valueChangeLines(c), "  "));
    }
  }

  return lines;
}

function nodeDiffLines(nd: NodeDiff): string[] {
  switch (nd.kind) {
    case "added":
      return [`+ "${nd.name}" (${nd.type})`];
    case "removed":
      return [`- "${nd.name}" (${nd.type})`];
    case "renamed":
      return [`~ "${nd.oldName}" → "${nd.name}" [renamed]`];
    case "modified": {
      const head = nd.oldName ? `~ "${nd.oldName}" → "${nd.name}":` : `~ "${nd.name}":`;
      const lines = [head];
      const changes = [...nd.parameterChanges, ...nd.otherChanges];
      lines.push(...indent(changes.flatMap(valueChangeLines), "  "));
      return lines;
    }
  }
}

export function valueChangeLines(c: ValueChange): string[] {
  if (c.lineChanges && c.lineChanges.length > 0) {
    const lines = [`${c.path}:`];
    for (const lc of c.lineChanges) {
      const sign = lc.kind === "added" ? "+" : "-";
      lines.push(`  ${sign} ${lc.text}`);
    }
    return lines;
  }

  const oldText = formatValue(c.oldValue);
  const newText = formatValue(c.newValue);
  if (oldText.includes("\n") || newText.includes("\n")) {
    // Multi-line values that did not qualify for a line diff (e.g. only one
    // side is a string): show each side as an indented block.
    return [
      `${c.path}:`,
      ...indent(
        oldText.split("\n").map((l) => `- ${l}`),
        "  ",
      ),
      ...indent(
        newText.split("\n").map((l) => `+ ${l}`),
        "  ",
      ),
    ];
  }
  return [`${c.path}: ${oldText} → ${newText}`];
}

function formatValue(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (typeof v === "string") return JSON.stringify(v);
  if (v == null) return "(empty)";
  const json = JSON.stringify(v);
  return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
}

function indent(lines: string[], prefix: string): string[] {
  return lines.map((l) => `${prefix}${l}`);
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/**
 * Renders each modified workflow as a Mermaid flowchart with change classes:
 * green = added, red = removed, yellow = modified, blue = renamed.
 * Suitable for pasting into PRs and Markdown documents.
 */
export function formatDiffMermaid(report: DiffReport): string {
  const blocks: string[] = [];

  for (const c of report.comparisons) {
    if (c.status === "unchanged") continue;
    if (c.status === "modified" && c.detail) {
      blocks.push(mermaidForWorkflow(c, c.detail));
    } else {
      const sign = c.status === "added" ? "+" : "-";
      blocks.push(`%% ${sign} workflow: ${c.name}`);
    }
  }

  if (blocks.length === 0) return "";
  return `${blocks.join("\n\n")}\n`;
}

function sanitizeMermaidId(name: string, used: Map<string, string>): string {
  const existing = used.get(name);
  if (existing) return existing;
  const base =
    name
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[0-9]/, "n$&") || "node";
  let id = base;
  let n = 1;
  const taken = new Set([...used.values()]);
  while (taken.has(id)) id = `${base}_${n++}`;
  used.set(name, id);
  return id;
}

function mermaidLabel(name: string): string {
  return name.replaceAll('"', "'");
}

function mermaidForWorkflow(c: WorkflowComparison, d: WorkflowDiffDetail): string {
  const used = new Map<string, string>();
  const kindByName = new Map<string, NodeDiff["kind"]>();
  for (const nd of d.nodeDiffs) {
    kindByName.set(nd.name, nd.kind);
    if (nd.oldName) kindByName.set(nd.oldName, nd.kind);
  }

  const lines: string[] = [`flowchart LR`, `  %% ${c.name}`];

  // Nodes referenced by edges but absent from nodeDiffs are context: draw them
  // plain so the changed region stays recognizable inside the whole flow.
  const allNames = new Set<string>();
  for (const nd of d.nodeDiffs) {
    allNames.add(nd.name);
    if (nd.oldName) allNames.add(nd.oldName);
  }
  for (const e of d.edgeDiffs) {
    allNames.add(e.source);
    allNames.add(e.target);
  }
  for (const name of [...allNames].sort()) {
    const id = sanitizeMermaidId(name, used);
    const kind = kindByName.get(name);
    const label = mermaidLabel(name);
    switch (kind) {
      case "added":
        lines.push(`  ${id}(["${label}"]):::added`);
        break;
      case "removed":
        lines.push(`  ${id}(["${label}"]):::removed`);
        break;
      case "renamed":
        lines.push(`  ${id}(["${label}"]):::renamed`);
        break;
      case "modified":
        lines.push(`  ${id}(["${label}"]):::modified`);
        break;
      default:
        lines.push(`  ${id}(["${label}"])`);
    }
  }

  for (const e of d.edgeDiffs) {
    const src = sanitizeMermaidId(e.source, used);
    const dst = sanitizeMermaidId(e.target, used);
    const cls = e.kind === "added" ? ":::edgeAdded" : ":::edgeRemoved";
    lines.push(`  ${src} -->|${e.connectionType}| ${dst}${cls}`);
  }

  // Renames that carried content edits are "modified" nodes with an oldName:
  // draw a dashed edge so the identity change stays visible next to the diff.
  for (const nd of d.nodeDiffs) {
    if (!nd.oldName) continue;
    const oldId = sanitizeMermaidId(nd.oldName, used);
    const newId = sanitizeMermaidId(nd.name, used);
    lines.push(`  ${oldId} -. renamed .-> ${newId}`);
  }

  lines.push(`  classDef added fill:#b7eb8f,stroke:#2f7d02;`);
  lines.push(`  classDef removed fill:#ffb3b3,stroke:#a8071a;`);
  lines.push(`  classDef modified fill:#ffe58f,stroke:#d48806;`);
  lines.push(`  classDef renamed fill:#91caff,stroke:#0958d9;`);
  lines.push(`  classDef edgeAdded stroke:#2f7d02,stroke-width:2px;`);
  lines.push(`  classDef edgeRemoved stroke:#a8071a,stroke-width:2px,stroke-dasharray:4;`);

  return lines.join("\n");
}
