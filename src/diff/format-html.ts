import { diffLines, stableJson } from "./engine.ts";
import { buildWorkflowMermaid } from "./format.ts";
import type {
  DiffReport,
  LineChange,
  NodeDiff,
  ValueChange,
  WorkflowComparison,
  WorkflowDiffDetail,
} from "./model.ts";

/**
 * Self-contained, graph-centric HTML report.
 *
 * The Mermaid diagram is the hero: clicking a node opens its node-level diff
 * in the side panel (workflow-level changes are the default panel content).
 * A static "All changes" section below keeps the full listing readable and
 * copy-pastable even without JavaScript or the Mermaid CDN.
 */
export function formatDiffHtml(report: DiffReport): string {
  const counts = countStatuses(report);
  const sections: string[] = [];
  const payloads: Record<string, PanelPayload> = {};

  report.comparisons.forEach((c, i) => {
    const key = `wf${i}`;
    if (c.status === "modified" && c.detail) {
      const model = buildWorkflowMermaid(c, c.detail);
      sections.push(renderModifiedWorkflow(key, c, c.detail, model.diagram));
      payloads[key] = buildPanelPayload(c, c.detail, model.nodeIdByName);
    } else {
      sections.push(renderSimpleWorkflow(c));
    }
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>n8n-cli workflow diff</title>
<style>
  :root {
    --bg: #0f1115; --card: #171a21; --border: #2a2f3a; --text: #d7dae0;
    --muted: #8b93a1; --add-bg: #10361c; --add-fg: #6ee787; --del-bg: #3d1218; --del-fg: #ff9494;
    --mod-fg: #e3b341; --ren-fg: #79c0ff; --accent: #ea4c71;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--text);
         font: 14px/1.55 -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .badges { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .badge { border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
  .badge b { color: var(--text); font-weight: 600; }
  .wf { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
        padding: 16px 18px; margin-bottom: 16px; max-width: 1240px; }
  .wf-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .status { font-weight: 700; font-size: 13px; padding: 1px 8px; border-radius: 5px; }
  .status.modified { background: rgba(227,179,65,.15); color: var(--mod-fg); }
  .status.added { background: var(--add-bg); color: var(--add-fg); }
  .status.removed { background: var(--del-bg); color: var(--del-fg); }
  .status.unchanged { color: var(--muted); }
  .wf-title { font-size: 15px; font-weight: 600; }
  .wf-id { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 10px minmax(300px, 440px); gap: 0 12px; align-items: start; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .splitter { display: none; } }
  .graph-pane { min-width: 0; }
  .graph { background: #fff; border-radius: 8px; padding: 8px; }
  .graph-toolbar { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
  .graph-toolbar button { background: var(--card); color: var(--text); border: 1px solid var(--border);
                          border-radius: 5px; font-size: 12px; padding: 2px 10px; cursor: pointer; }
  .graph-toolbar button:hover { border-color: var(--ren-fg); }
  .graph-toolbar .zoomlevel { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .graph-viewport { overflow: hidden; height: 620px; position: relative; cursor: grab;
                    background: #f8f9fb; border-radius: 6px; }
  .graph-viewport.panning { cursor: grabbing; }
  .graph-viewport svg { transform-origin: 0 0; }
  .splitter { width: 10px; height: 100%; min-height: 300px; cursor: col-resize; display: flex;
              align-items: center; justify-content: center; border-radius: 5px; }
  .splitter:hover, .splitter.active { background: rgba(121,192,255,.15); }
  .splitter::after { content: ""; width: 3px; height: 44px; border-radius: 2px; background: var(--border); }
  .legend { display: flex; gap: 12px; margin-bottom: 8px; font-size: 12px; color: #555; flex-wrap: wrap; }
  .legend-item { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid #ccc; }
  .hint { margin-top: 8px; font-size: 12px; color: var(--muted); }
  .mermaid { background: #fff; }
  .diff-clickable { cursor: pointer; }
  .diff-clickable:hover { opacity: 0.85; }
  .panel { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
           font-size: 13px; max-height: 640px; overflow: auto; }
  .panel h4 { margin: 0 0 8px; font-size: 13px; }
  .panel .back { display: inline-block; margin-bottom: 8px; color: var(--ren-fg); cursor: pointer; font-size: 12px; }
  .panel .default-title { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 12px 0 4px; }
  .panel .default-title:first-of-type { margin-top: 0; }
  .diff { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12.5px;
          border-radius: 6px; overflow: hidden; border: 1px solid var(--border); margin: 4px 0; }
  .dline { padding: 1px 10px; white-space: pre-wrap; word-break: break-all; }
  .dline.ctx { color: var(--muted); background: rgba(255,255,255,.04); }
  .dline.added { background: var(--add-bg); color: var(--add-fg); }
  .dline.removed { background: var(--del-bg); color: var(--del-fg); }
  .node-card { border-top: 1px solid var(--border); padding: 12px 0; }
  .node-kind { display: inline-block; width: 14px; font-weight: 700; }
  .node-kind.added { color: var(--add-fg); } .node-kind.removed { color: var(--del-fg); }
  .node-kind.modified { color: var(--mod-fg); } .node-kind.renamed { color: var(--ren-fg); }
  .node-kind.unchanged { color: var(--muted); }
  .node-name { font-weight: 600; }
  .node-type { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }
  .changes { margin: 8px 0 0 18px; }

  .empty { color: var(--muted); font-style: italic; }
  h3 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
       margin: 18px 0 6px; }
  details.all { margin-top: 4px; }
  details.all summary, details.rawjson summary { cursor: pointer; color: var(--ren-fg); font-size: 13px; }
  details.rawjson { margin-top: 10px; }
  .rawcount { color: var(--muted); font-size: 12px; margin-left: 8px; }
  .lnum { display: inline-block; min-width: 40px; margin-right: 10px; color: var(--muted); text-align: right; }
</style>
</head>
<body>
<h1>n8n-cli workflow diff</h1>
<div class="meta">left = old state &nbsp;→&nbsp; right = new state &nbsp;·&nbsp; generated by n8n-cli diff</div>
<div class="badges">
  <span class="badge">modified <b>${counts.modified}</b></span>
  <span class="badge">added <b>${counts.added}</b></span>
  <span class="badge">removed <b>${counts.removed}</b></span>
  <span class="badge">unchanged <b>${counts.unchanged}</b></span>
</div>
${sections.join("\n")}
<script type="application/json" id="diff-data">${embedData(payloads)}</script>
<script>
${panelScript()}
${graphScript()}
</script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, theme: "neutral" });
  mermaid.run({ querySelector: ".mermaid" }).then(() => window.__wireGraphNodes && window.__wireGraphNodes());
</script>
</body>
</html>
`;
}

function countStatuses(report: DiffReport): Record<string, number> {
  const counts: Record<string, number> = { modified: 0, added: 0, removed: 0, unchanged: 0 };
  for (const c of report.comparisons) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Workflow sections
// ---------------------------------------------------------------------------

const LEGEND = [
  ["#b7eb8f", "added"],
  ["#ffb3b3", "removed"],
  ["#ffe58f", "modified"],
  ["#91caff", "renamed"],
  ["#e4e7eb", "unchanged"],
] as const;

function workflowHead(c: WorkflowComparison): string {
  const statusLabel =
    c.status === "modified" ? "M" : c.status === "added" ? "+" : c.status === "removed" ? "−" : "=";
  return `<div class="wf-head">
    <span class="status ${c.status}">${statusLabel} ${esc(c.status)}</span>
    <span class="wf-title">${esc(c.name)}</span>
    ${c.workflowId ? `<span class="wf-id">${esc(c.workflowId)}</span>` : ""}
  </div>`;
}

function renderModifiedWorkflow(
  key: string,
  c: WorkflowComparison,
  d: WorkflowDiffDetail,
  diagram: string,
): string {
  const legend = LEGEND.map(
    ([color, label]) =>
      `<span class="legend-item"><span class="swatch" style="background:${color}"></span>${label}</span>`,
  ).join("");

  return `<section class="wf" data-key="${key}">
  ${workflowHead(c)}
  <div class="grid">
    <div class="graph-pane">
      <div class="graph">
        <div class="legend">${legend}</div>
        <div class="graph-toolbar">
          <button type="button" data-zoom="out" title="Zoom out">−</button>
          <button type="button" data-zoom="in" title="Zoom in">+</button>
          <button type="button" data-zoom="reset" title="Reset view">⌂ fit</button>
          <span class="zoomlevel">100%</span>
          <span class="zoomlevel">drag to pan · wheel to zoom</span>
        </div>
        <div class="graph-viewport"><pre class="mermaid">${esc(diagram)}</pre></div>
      </div>
      <div class="hint">Click a node in the diagram to inspect its diff. Gray nodes are unchanged.</div>
    </div>
    <div class="splitter" title="Drag to resize"></div>
    <aside class="panel" data-panel="${key}">${renderPanelDefault(d)}</aside>
  </div>
  <details class="all">
    <summary>All changes (static list)</summary>
    ${renderAllChanges(d)}
  </details>
  ${renderRawJsonDiff(c)}
</section>`;
}

/**
 * A genuine line diff of the two pretty-printed, key-sorted workflow JSON
 * documents — the "raw" view for when the structured summary is not enough.
 * Only changed lines are rendered; key sorting keeps pure reordering silent.
 */
function renderRawJsonDiff(c: WorkflowComparison, maxLines = 5000): string {
  const left = (c as { leftRaw?: unknown }).leftRaw;
  const right = (c as { rightRaw?: unknown }).rightRaw;
  if (left === undefined || right === undefined) return "";

  const changes = diffLines(stableJson(left, 2), stableJson(right, 2), maxLines);
  if (changes === null) {
    return `<details class="rawjson"><summary>Raw JSON diff</summary><p class="empty">workflow JSON exceeds ${maxLines} lines; use --format json for the full documents</p></details>`;
  }
  if (changes.length === 0) {
    return `<details class="rawjson"><summary>Raw JSON diff</summary><p class="empty">JSON documents are identical</p></details>`;
  }

  const added = changes.filter((l) => l.kind === "added").length;
  const removed = changes.filter((l) => l.kind === "removed").length;
  const rows = changes
    .map(
      (l) =>
        `<div class="dline ${l.kind}"><span class="lnum">${l.lineNumber}</span>${l.kind === "added" ? "+" : "-"} ${esc(l.text)}</div>`,
    )
    .join("");
  return `<details class="rawjson"><summary>Raw JSON diff <span class="rawcount">+${added} −${removed}</span></summary><div class="diff">${rows}</div></details>`;
}

function renderSimpleWorkflow(c: WorkflowComparison): string {
  let body: string;
  switch (c.status) {
    case "unchanged":
      body = `<p class="empty">no changes</p>`;
      break;
    case "added":
    case "removed":
      body = `<p class="empty">${c.status} on ${c.status === "added" ? esc(c.rightSource ?? "right") : esc(c.leftSource ?? "left")} side</p>`;
      break;
    default:
      body = "";
  }
  return `<section class="wf">
  ${workflowHead(c)}
  ${body}
</section>`;
}

// ---------------------------------------------------------------------------
// Panel (default = workflow-level view; node view is rendered client-side)
// ---------------------------------------------------------------------------

interface PanelPayload {
  name: string;
  nodes: Record<string, PanelNode>;
}

interface PanelNode {
  kind: string;
  name: string;
  oldName?: string;
  type: string;
  changes: ValueChange[];
}

function buildPanelPayload(
  c: WorkflowComparison,
  d: WorkflowDiffDetail,
  nodeIdByName: Record<string, string>,
): PanelPayload {
  const byName = new Map<string, PanelNode>();
  for (const nd of d.nodeDiffs) {
    const panelNode: PanelNode = {
      kind: nd.kind,
      name: nd.name,
      oldName: nd.oldName,
      type: nd.type,
      changes: [...nd.parameterChanges, ...nd.otherChanges, ...fullParameterChanges(nd)],
    };
    byName.set(nd.name, panelNode);
    if (nd.oldName) byName.set(nd.oldName, panelNode);
  }
  for (const un of d.unchangedNodes) {
    if (!byName.has(un.name)) {
      byName.set(un.name, { kind: "unchanged", name: un.name, type: un.type, changes: [] });
    }
  }

  const nodes: Record<string, PanelNode> = {};
  for (const [id, name] of Object.entries(nodeIdByName)) {
    const nd = byName.get(name);
    if (nd) nodes[id] = nd;
  }
  return { name: c.name, nodes };
}

function embedData(payloads: Record<string, PanelPayload>): string {
  // `<` is escaped so a "</script>" inside workflow data cannot break out.
  return JSON.stringify(payloads).replaceAll("<", "\\u003c");
}

function renderPanelDefault(d: WorkflowDiffDetail): string {
  const parts: string[] = [];
  parts.push(`<h4>Workflow changes</h4>`);
  parts.push(`<div class="default-title">metadata</div>`);
  parts.push(
    d.metadataChanges.length > 0
      ? `<div class="diff">${d.metadataChanges.map(diffBlock).join("")}</div>`
      : `<span class="empty">none</span>`,
  );
  parts.push(`<div class="default-title">connections</div>`);
  parts.push(
    d.edgeDiffs.length > 0
      ? `<div class="diff">${d.edgeDiffs.map(edgeLine).join("")}</div>`
      : `<span class="empty">none</span>`,
  );
  parts.push(`<div class="default-title">settings</div>`);
  parts.push(
    d.settingsChanges.length > 0
      ? `<div class="diff">${d.settingsChanges.map(diffBlock).join("")}</div>`
      : `<span class="empty">none</span>`,
  );
  if (d.pinDataChanges.length > 0) {
    parts.push(`<div class="default-title">pinned data</div>`);
    parts.push(`<div class="diff">${d.pinDataChanges.map(diffBlock).join("")}</div>`);
  }
  parts.push(
    `<div class="hint">Click a node in the diagram to see its parameter-level diff.</div>`,
  );
  return parts.join("\n");
}

/** The client-side node panel renderer. Kept as a plain string for full control. */

/**
 * Client-side graph interaction: wheel zoom, drag pan, toolbar controls, and
 * a draggable splitter between the graph pane and the detail panel. Real
 * workflows render large diagrams, so the viewport starts tall and supports
 * free zoom (15%-600%) plus fit-to-view.
 */
function graphScript(): string {
  return `
(function () {
  var MIN_SCALE = 0.15, MAX_SCALE = 6;

  function prepareSvg(viewport) {
    var svg = viewport.querySelector("svg");
    if (!svg || svg.dataset.prepared) return svg;
    svg.dataset.prepared = "1";
    svg.style.maxWidth = "none";
    var vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width && vb.height) {
      svg.style.width = vb.width + "px";
      svg.style.height = vb.height + "px";
    }
    return svg;
  }

  function setupPane(pane) {
    var viewport = pane.querySelector(".graph-viewport");
    if (!viewport || viewport.dataset.graphSetup) return;
    viewport.dataset.graphSetup = "1";

    var state = { s: 1, x: 0, y: 0 };
    var label = pane.querySelector(".zoomlevel");
    function apply() {
      var svg = viewport.querySelector("svg");
      if (svg) svg.style.transform = "translate(" + state.x + "px," + state.y + "px) scale(" + state.s + ")";
      if (label) label.textContent = Math.round(state.s * 100) + "%";
    }
    function zoomAt(f, mx, my) {
      var ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.s * f));
      f = ns / state.s;
      state.x = mx - (mx - state.x) * f;
      state.y = my - (my - state.y) * f;
      state.s = ns;
      apply();
    }
    function fit() {
      var svg = prepareSvg(viewport);
      if (!svg || !svg.viewBox || !svg.viewBox.baseVal.width) return;
      var vb = svg.viewBox.baseVal;
      var s = Math.min(viewport.clientWidth / vb.width, viewport.clientHeight / vb.height, 1);
      state.s = s;
      state.x = (viewport.clientWidth - vb.width * s) / 2;
      state.y = (viewport.clientHeight - vb.height * s) / 2;
      apply();
    }

    viewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = viewport.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    // Drag to pan. Nodes are excluded so their click handlers keep working.
    var drag = null;
    viewport.addEventListener("mousedown", function (e) {
      if (e.target.closest && e.target.closest(".diff-clickable")) return;
      drag = { x: e.clientX, y: e.clientY, ox: state.x, oy: state.y };
      viewport.classList.add("panning");
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!drag) return;
      state.x = drag.ox + (e.clientX - drag.x);
      state.y = drag.oy + (e.clientY - drag.y);
      apply();
    });
    window.addEventListener("mouseup", function () {
      drag = null;
      viewport.classList.remove("panning");
    });

    pane.querySelectorAll("[data-zoom]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-zoom");
        if (kind === "reset") { fit(); return; }
        zoomAt(kind === "in" ? 1.2 : 1 / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
      });
    });

    viewport.fitView = fit;
    apply();
  }

  function setupSplitter(handle) {
    if (handle.dataset.splitterSetup) return;
    handle.dataset.splitterSetup = "1";
    var grid = handle.closest(".grid");
    if (!grid) return;
    handle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      handle.classList.add("active");
      function onMove(ev) {
        var rect = grid.getBoundingClientRect();
        var panelW = Math.min(760, Math.max(280, rect.right - ev.clientX - 5));
        grid.style.gridTemplateColumns = "minmax(0, 1fr) 10px " + panelW + "px";
      }
      function onUp() {
        handle.classList.remove("active");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  document.querySelectorAll(".graph-pane").forEach(setupPane);
  document.querySelectorAll(".splitter").forEach(setupSplitter);

  // Called by the Mermaid module once the SVG exists: size it naturally and
  // fit the whole diagram into the viewport.
  window.__wireGraphNodes = (function (orig) {
    return function () {
      document.querySelectorAll(".graph-pane").forEach(function (pane) {
        var viewport = pane.querySelector(".graph-viewport");
        if (viewport && viewport.fitView) viewport.fitView();
      });
      if (orig) orig();
    };
  })(window.__wireGraphNodes);
})();
`;
}

function panelScript(): string {
  return `
(function () {
  var DATA;
  try { DATA = JSON.parse(document.getElementById("diff-data").textContent); } catch (e) { DATA = {}; }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function plain(v) {
    var t = typeof v === "string" ? v : JSON.stringify(v);
    if (t === undefined) return "";
    if (t.length > 200) t = t.slice(0, 197) + "...";
    return t;
  }
  function changeHtml(c) {
    // Same git-diff hunk layout as the static list: context path line, then
    // "- old" / "+ new" rows (or the line-level diff for code parameters).
    var rows = '<div class="dline ctx">' + esc(c.path) + "</div>";
    if (c.lineChanges && c.lineChanges.length > 0) {
      rows += c.lineChanges.map(function (l) {
        return '<div class="dline ' + l.kind + '">' + (l.kind === "added" ? "+" : "-") + " " + esc(l.text) + "</div>";
      }).join("");
    } else {
      if (c.oldValue !== undefined) rows += '<div class="dline removed">- ' + esc(plain(c.oldValue)) + "</div>";
      if (c.newValue !== undefined) rows += '<div class="dline added">+ ' + esc(plain(c.newValue)) + "</div>";
    }
    return '<div class="diff">' + rows + "</div>";
  }

  function showNode(key, id) {
    var panel = document.querySelector('[data-panel="' + key + '"]');
    var wf = DATA[key];
    var n = wf && wf.nodes && wf.nodes[id];
    if (!panel || !n) return;
    var title = n.oldName
      ? esc(n.oldName) + ' <span class="arrow">\\u2192</span> ' + esc(n.name)
      : esc(n.name);
    var html = '<span class="back" data-back="' + key + '">\\u2190 workflow</span>';
    html += "<h4><span class='node-kind " + n.kind + "'>" + (n.kind === "added" ? "+" : n.kind === "removed" ? "\\u2212" : "~") +
      "</span> " + title + "</h4>";
    html += '<div class="node-type">' + esc(n.type) + " \\u00b7 " + esc(n.kind) + "</div>";
    if (n.changes.length === 0) {
      html += '<p class="empty">no parameter changes</p>';
    } else {
      html += '<div class="changes">' + n.changes.map(changeHtml).join("") + "</div>";
    }
    panel.innerHTML = html;
    var back = panel.querySelector("[data-back]");
    if (back) back.addEventListener("click", function () { resetPanel(key); });
  }

  function resetPanel(key) {
    var section = document.querySelector('section.wf[data-key="' + key + '"]');
    var tpl = section && section.querySelector("template[data-panel-default]");
    var panel = document.querySelector('[data-panel="' + key + '"]');
    if (tpl && panel) {
      panel.innerHTML = "";
      panel.appendChild(tpl.content.cloneNode(true));
    }
  }

  window.__wireGraphNodes = function () {
    Object.keys(DATA).forEach(function (key) {
      var wf = DATA[key];
      var section = document.querySelector('section.wf[data-key="' + key + '"]');
      if (!section) return;
      // Keep a pristine copy of the default panel for the back action.
      var panel = section.querySelector(".panel");
      if (panel && !section.querySelector("template[data-panel-default]")) {
        var tpl = document.createElement("template");
        tpl.setAttribute("data-panel-default", "");
        tpl.content.appendChild(panel.cloneNode(true));
        section.appendChild(tpl);
      }
      Object.keys(wf.nodes || {}).forEach(function (id) {
        // Mermaid prefixes node ids per render (e.g. "mermaid-<ts>-flowchart-"
        // + id + "-N"), so match by containment rather than prefix.
        var els = section.querySelectorAll('[id*="flowchart-' + id + '-"]');
        els.forEach(function (el) {
          el.classList.add("diff-clickable");
          el.addEventListener("click", function () { showNode(key, id); });
        });
      });
    });
  };
})();
`;
}

// ---------------------------------------------------------------------------
// Static "All changes" listing
// ---------------------------------------------------------------------------

function renderAllChanges(d: WorkflowDiffDetail): string {
  const parts: string[] = [];

  if (d.metadataChanges.length > 0) {
    parts.push(
      `<h3>Metadata</h3><div class="diff">${d.metadataChanges.map(diffBlock).join("")}</div>`,
    );
  }

  if (d.nodeDiffs.length > 0) {
    parts.push(`<h3>Nodes</h3>${d.nodeDiffs.map(renderNodeCard).join("\n")}`);
  }

  if (d.edgeDiffs.length > 0) {
    const rows = d.edgeDiffs.map(edgeLine).join("");
    parts.push(`<h3>Connections</h3><div class="diff">${rows}</div>`);
  }

  if (d.settingsChanges.length > 0) {
    parts.push(
      `<h3>Settings</h3><div class="diff">${d.settingsChanges.map(diffBlock).join("")}</div>`,
    );
  }

  if (d.pinDataChanges.length > 0) {
    parts.push(
      `<h3>Pinned data</h3><div class="diff">${d.pinDataChanges.map(diffBlock).join("")}</div>`,
    );
  }

  return parts.join("\n") || `<p class="empty">no changes</p>`;
}

function renderNodeCard(nd: NodeDiff): string {
  const sign = nd.kind === "added" ? "+" : nd.kind === "removed" ? "−" : "~";
  const title = nd.oldName
    ? `${esc(nd.oldName)} <span class="arrow">→</span> ${esc(nd.name)}${nd.kind === "renamed" ? ` <em style="color:var(--ren-fg)">renamed</em>` : ""}`
    : esc(nd.name);

  const changes = [...nd.parameterChanges, ...nd.otherChanges, ...fullParameterChanges(nd)];
  const changeBlocks =
    changes.length > 0 ? `<div class="changes">${changes.map(diffBlock).join("")}</div>` : "";

  return `<div class="node-card">
  <span class="node-kind ${nd.kind}">${sign}</span>
  <span class="node-name">${title}</span>
  <span class="node-type">${esc(nd.type)}</span>
  ${changeBlocks}
</div>`;
}

/**
 * Expands a node's full parameter snapshot (present on added/removed nodes)
 * into synthetic per-leaf ValueChanges — the equivalent of git showing every
 * line of a new or deleted file as added or removed.
 */
function fullParameterChanges(nd: NodeDiff): ValueChange[] {
  if (!nd.fullParameters) return [];
  const sign = nd.kind === "added" ? ("newValue" as const) : ("oldValue" as const);
  return flattenLeaves(nd.fullParameters, "parameters").map(({ path, value }) => ({
    path,
    [sign]: value,
  }));
}

function flattenLeaves(v: unknown, prefix: string): Array<{ path: string; value: unknown }> {
  if (Array.isArray(v)) {
    return v.flatMap((item, i) => flattenLeaves(item, `${prefix}[${i}]`));
  }
  if (v != null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return [{ path: prefix, value: v }];
    return entries.flatMap(([k, val]) => flattenLeaves(val, `${prefix}.${k}`));
  }
  return [{ path: prefix, value: v }];
}

/**
 * One change rendered as a git diff hunk: the path as a context line, then
 * `- old` / `+ new` rows (or the line-level diff for code parameters).
 */
function diffBlock(c: ValueChange): string {
  const rows: string[] = [`<div class="dline ctx">${esc(c.path)}</div>`];
  if (c.lineChanges && c.lineChanges.length > 0) {
    for (const l of c.lineChanges) rows.push(lineRow(l));
  } else {
    if (c.oldValue !== undefined) {
      rows.push(`<div class="dline removed">- ${esc(formatScalar(c.oldValue))}</div>`);
    }
    if (c.newValue !== undefined) {
      rows.push(`<div class="dline added">+ ${esc(formatScalar(c.newValue))}</div>`);
    }
  }
  return rows.join("");
}

function edgeLine(e: {
  kind: "added" | "removed";
  source: string;
  target: string;
  connectionType: string;
  sourceOutputIndex: number;
}): string {
  const sign = e.kind === "added" ? "+" : "-";
  const cls = e.kind === "added" ? "added" : "removed";
  return `<div class="dline ${cls}">${sign} "${esc(e.source)}" →[${esc(e.connectionType)}:${e.sourceOutputIndex}] "${esc(e.target)}"</div>`;
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") return v;
  const json = JSON.stringify(v);
  return json.length <= 200 ? json : `${json.slice(0, 197)}...`;
}

function lineRow(l: LineChange): string {
  const sign = l.kind === "added" ? "+" : "-";
  return `<div class="dline ${l.kind}">${sign} ${esc(l.text)}</div>`;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
