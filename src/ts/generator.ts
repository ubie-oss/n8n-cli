import { generateWorkflowCode, SDK_IMPORTABLE_FUNCTIONS } from "@n8n/workflow-sdk";
import * as acorn from "acorn";
import type { Workflow } from "@/api/types.ts";
import { META_EXPORT_NAME, type TsWorkflowMeta } from "./preprocess.ts";

/** npm package the generated import statement points at. */
const SDK_PACKAGE = "@n8n/workflow-sdk";

const IMPORTABLE = new Set<string>(SDK_IMPORTABLE_FUNCTIONS);

/**
 * Emits a `.ts` workflow file from a Workflow.
 *
 * `generateWorkflowCode()` produces bare calls — `workflow(...)`, `node(...)` —
 * with no import statement, because its own parser rejects imports. That is fine
 * for the SDK but useless in an editor, so we prepend the import ourselves; the
 * loader strips it again before parsing (see `ts/preprocess.ts`).
 */
export function generateTsWorkflow(workflow: Workflow): string {
  const body = restoreOriginPositions(
    generateWorkflowCode(toSdkJson(workflow)),
    workflow,
  ).trimEnd();

  const sections = [importStatement(body)];

  const meta = extractMeta(workflow);
  if (meta) sections.push(meta);

  sections.push(body);

  return `${sections.join("\n\n")}\n`;
}

/**
 * Builds the import statement for the SDK functions the generated code calls.
 *
 * Parsed with acorn rather than matched with a regex: node parameters can hold
 * arbitrary JavaScript (a Code node's `jsCode`, say), and names like `merge`,
 * `tool` and `node` are common enough that scanning the raw text would import
 * functions the file never calls — breaking `noUnusedImports` in the user's repo.
 */
function importStatement(code: string): string {
  const used = new Set<string>();

  let program: acorn.Program;
  try {
    program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    // Unparseable generated code is caught by the round-trip check in
    // `importer/writer.ts`; importing nothing keeps this function total.
    return `import {} from "${SDK_PACKAGE}";`;
  }

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = (node as acorn.CallExpression).callee;
    if (callee.type === "Identifier" && IMPORTABLE.has(callee.name)) {
      used.add(callee.name);
    }
  });

  if (used.size === 0) return `import {} from "${SDK_PACKAGE}";`;

  // Keep the SDK's own ordering so the line is stable across regenerations.
  const ordered = SDK_IMPORTABLE_FUNCTIONS.filter((fn) => used.has(fn));
  return `import { ${ordered.join(", ")} } from "${SDK_PACKAGE}";`;
}

/**
 * Re-adds `position: [0, 0]` to nodes the SDK dropped it from.
 *
 * `generateWorkflowCode()` treats `[0, 0]` as "no position given" and omits it,
 * and re-parsing then auto-lays-the-node-out somewhere else. That matters
 * because `n8n-cli fmt` anchors the top-left node at exactly `[0, 0]`, so
 * without this every formatted workflow would be unconvertible. Explicit
 * `position: [0, 0]` in the source *is* honoured on parse, so put it back.
 */
function restoreOriginPositions(code: string, workflow: Workflow): string {
  const atOrigin = new Set(
    workflow.nodes.filter((n) => n.position?.[0] === 0 && n.position?.[1] === 0).map((n) => n.name),
  );
  if (atOrigin.size === 0) return code;

  let program: acorn.Program;
  try {
    program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return code;
  }

  // Offsets shift as soon as text is inserted, so collect first and apply from
  // the end backwards.
  const insertAt: number[] = [];

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const call = node as acorn.CallExpression;
    if (call.callee.type !== "Identifier" || !IMPORTABLE.has(call.callee.name)) return;

    const arg = call.arguments[0];
    if (arg?.type !== "ObjectExpression") return;

    const config = findProperty(arg, "config");
    if (config?.type !== "ObjectExpression") return;

    const name = findProperty(config, "name");
    if (name?.type !== "Literal" || typeof name.value !== "string") return;
    if (!atOrigin.has(name.value)) return;

    // Already explicit — nothing to restore.
    if (findProperty(config, "position")) return;

    insertAt.push(config.start + 1);
  });

  let result = code;
  for (const offset of insertAt.sort((a, b) => b - a)) {
    result = `${result.slice(0, offset)} position: [0, 0],${result.slice(offset)}`;
  }
  return result;
}

/** Returns the value of a non-computed property, or undefined. */
function findProperty(obj: acorn.ObjectExpression, key: string): acorn.Expression | undefined {
  for (const prop of obj.properties) {
    if (prop.type !== "Property" || prop.computed) continue;
    const name =
      prop.key.type === "Identifier"
        ? prop.key.name
        : prop.key.type === "Literal"
          ? String(prop.key.value)
          : null;
    if (name === key) return prop.value as acorn.Expression;
  }
  return undefined;
}

/** Depth-first walk over every AST node. */
function walk(node: unknown, visit: (node: acorn.Node) => void): void {
  if (node == null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }

  const candidate = node as acorn.Node;
  if (typeof candidate.type !== "string") return;
  visit(candidate);

  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    walk(value, visit);
  }
}

/**
 * Renders the `export const meta` block for fields the SDK cannot represent.
 * Returns null when there is nothing worth writing.
 */
function extractMeta(workflow: Workflow): string | null {
  const meta: TsWorkflowMeta = {};

  // Written unconditionally, including `false`. A generated file that omitted it
  // would read back as inactive, and apply would deactivate a running workflow.
  meta.active = workflow.active === true;

  if (workflow.isArchived) meta.isArchived = true;

  // Written only when the workflow actually has one. Emitting `description: ""`
  // for every workflow without a description would turn a generated file into
  // one that actively clears the field on the next apply.
  if (workflow.description) meta.description = workflow.description;
  if (workflow.folderPath !== undefined) meta.folderPath = workflow.folderPath;
  if (workflow.folderId !== undefined) meta.folderId = workflow.folderId;

  const tags = (workflow.tags ?? []).map((t) => t.name).filter((n): n is string => !!n);
  if (tags.length > 0) meta.tags = tags;

  // Recorded so `import` can tell whether the local file is already current and
  // leave the author's formatting alone. See TsWorkflowMeta.updatedAt.
  if (workflow.updatedAt) meta.updatedAt = workflow.updatedAt;

  const nodeIds: Record<string, string> = {};
  for (const node of workflow.nodes) {
    if (node.name && node.id) nodeIds[node.name] = node.id;
  }
  if (Object.keys(nodeIds).length > 0) meta.nodeIds = nodeIds;

  const lines = [`export const ${META_EXPORT_NAME} = {`];
  lines.push(`  active: ${meta.active},`);
  if (meta.isArchived !== undefined) lines.push(`  isArchived: ${meta.isArchived},`);
  if (meta.description !== undefined) {
    lines.push(`  description: ${JSON.stringify(meta.description)},`);
  }
  if (meta.folderPath !== undefined) {
    lines.push(`  folderPath: ${JSON.stringify(meta.folderPath)},`);
  }
  if (meta.folderId !== undefined) lines.push(`  folderId: ${JSON.stringify(meta.folderId)},`);
  if (meta.tags) {
    lines.push(`  tags: [${meta.tags.map((t) => JSON.stringify(t)).join(", ")}],`);
  }
  if (meta.updatedAt) lines.push(`  updatedAt: ${JSON.stringify(meta.updatedAt)},`);
  if (meta.nodeIds) {
    lines.push("  nodeIds: {");
    for (const [name, id] of Object.entries(meta.nodeIds)) {
      lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(id)},`);
    }
    lines.push("  },");
  }
  lines.push("};");
  return lines.join("\n");
}

/** Narrows a Workflow to the shape `generateWorkflowCode()` expects. */
// biome-ignore lint/suspicious/noExplicitAny: the SDK's WorkflowJSON is structurally compatible but nominally distinct.
function toSdkJson(workflow: Workflow): any {
  return {
    id: workflow.id ?? "",
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    ...(workflow.settings ? { settings: workflow.settings } : {}),
    ...(workflow.pinData ? { pinData: workflow.pinData } : {}),
  };
}
