import { generateWorkflowCode, SDK_IMPORTABLE_FUNCTIONS } from "@n8n/workflow-sdk";
import type { Workflow } from "@/api/types.ts";
import { META_EXPORT_NAME, type TsWorkflowMeta } from "./preprocess.ts";

/** npm package the generated import statement points at. */
const SDK_PACKAGE = "@n8n/workflow-sdk";

/**
 * Emits a `.ts` workflow file from a Workflow.
 *
 * `generateWorkflowCode()` produces bare calls — `workflow(...)`, `node(...)` —
 * with no import statement, because its own parser rejects imports. That is fine
 * for the SDK but useless in an editor, so we prepend the import ourselves; the
 * loader strips it again before parsing (see `ts/preprocess.ts`).
 */
export function generateTsWorkflow(workflow: Workflow): string {
  const body = generateWorkflowCode(toSdkJson(workflow)).trimEnd();

  const sections = [importStatement(body)];

  const meta = extractMeta(workflow);
  if (meta) sections.push(meta);

  sections.push(body);

  return `${sections.join("\n\n")}\n`;
}

/**
 * Builds the import statement for the SDK functions the generated code uses.
 *
 * Only functions actually referenced are imported, so the file stays clean and
 * does not trip "unused import" lint rules in the user's repository.
 */
function importStatement(code: string): string {
  const used = SDK_IMPORTABLE_FUNCTIONS.filter((fn) =>
    new RegExp(`(?<![\\w$.])${fn}\\s*\\(`).test(code),
  );
  if (used.length === 0) return `import {} from "${SDK_PACKAGE}";`;
  return `import { ${used.join(", ")} } from "${SDK_PACKAGE}";`;
}

/**
 * Renders the `export const meta` block for fields the SDK cannot represent.
 * Returns null when there is nothing worth writing.
 */
function extractMeta(workflow: Workflow): string | null {
  const meta: TsWorkflowMeta = {};
  if (workflow.active) meta.active = true;
  if (workflow.isArchived) meta.isArchived = true;

  const tags = (workflow.tags ?? []).map((t) => t.name).filter((n): n is string => !!n);
  if (tags.length > 0) meta.tags = tags;

  // Recorded so `import` can tell whether the local file is already current and
  // leave the author's formatting alone. See TsWorkflowMeta.updatedAt.
  if (workflow.updatedAt) meta.updatedAt = workflow.updatedAt;

  if (Object.keys(meta).length === 0) return null;

  const lines = [`export const ${META_EXPORT_NAME} = {`];
  if (meta.active !== undefined) lines.push(`  active: ${meta.active},`);
  if (meta.isArchived !== undefined) lines.push(`  isArchived: ${meta.isArchived},`);
  if (meta.tags) {
    lines.push(`  tags: [${meta.tags.map((t) => JSON.stringify(t)).join(", ")}],`);
  }
  if (meta.updatedAt) lines.push(`  updatedAt: ${JSON.stringify(meta.updatedAt)},`);
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
