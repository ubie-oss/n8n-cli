import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { Workflow } from "@/api/types.ts";
import { generateDirnameWithID } from "@/naming/naming.ts";
import { extractExternalFiles, type FileType } from "./extractor.ts";
import { createIncludeDumpSchema, IncludeRef } from "./include-schema.ts";

/** Maximum filename length in bytes. */
const MaxFilenameBytes = 200;

/** Directory name for external files extracted from YAML workflows. */
export const SubfilesDir = "_subfiles";

/** Sanitizes a node name to a safe filename. */
export function sanitizeNodeName(name: string): string {
  if (!name) return "unnamed";

  const replacements: Record<string, string> = {
    " ": "-",
    "/": "-",
    "\\": "-",
    ":": "-",
    "*": "-",
    "?": "-",
    '"': "-",
    "<": "-",
    ">": "-",
    "|": "-",
    "&": "-and-",
  };

  let result = name;
  for (const [old, rep] of Object.entries(replacements)) {
    result = result.replaceAll(old, rep);
  }

  // Remove consecutive dashes
  result = result.replace(/-+/g, "-");
  // Remove leading/trailing dashes
  result = result.replace(/^-+|-+$/g, "");

  // Truncate if too long (preserve UTF-8 boundaries — JS strings are already Unicode)
  if (new TextEncoder().encode(result).length > MaxFilenameBytes) {
    const encoder = new TextEncoder();
    let truncated = result;
    while (encoder.encode(truncated).length > MaxFilenameBytes) {
      truncated = truncated.slice(0, -1);
    }
    result = truncated;
  }

  if (!result) return "unnamed";

  return result.toLowerCase();
}

/** Strips existing JS header comments to prevent duplication on re-import. */
export function stripJavaScriptHeaders(code: string): string {
  const lines = code.split("\n");
  let startIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.startsWith("// Node:") || trimmed.startsWith("// Workflow:")) {
      startIdx = i + 1;
    } else if (trimmed === "" && startIdx > 0 && i === startIdx) {
      startIdx = i + 1;
    } else if (trimmed !== "") {
      break;
    }
  }

  if (startIdx >= lines.length) return "";
  return lines.slice(startIdx).join("\n");
}

/** Strips existing SQL header comments to prevent duplication on re-import. */
export function stripSQLHeaders(code: string): string {
  const lines = code.split("\n");
  let startIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.startsWith("-- Node:") || trimmed.startsWith("-- Workflow:")) {
      startIdx = i + 1;
    } else if (trimmed === "" && startIdx > 0 && i === startIdx) {
      startIdx = i + 1;
    } else if (trimmed !== "") {
      break;
    }
  }

  if (startIdx >= lines.length) return "";
  return lines.slice(startIdx).join("\n");
}

/**
 * Strips existing Markdown header comments and expression prefix.
 * Returns [cleanCode, hadExpressionPrefix].
 */
export function stripMarkdownHeaders(code: string): [string, boolean] {
  let hasExpression = false;
  let workingCode = code;

  if (workingCode.startsWith("=")) {
    hasExpression = true;
    workingCode = workingCode.slice(1);
  }

  const lines = workingCode.split("\n");
  let startIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (
      (trimmed.startsWith("<!-- Node:") && trimmed.endsWith("-->")) ||
      (trimmed.startsWith("<!-- Workflow:") && trimmed.endsWith("-->"))
    ) {
      startIdx = i + 1;
    } else if (trimmed === "" && startIdx > 0 && i === startIdx) {
      startIdx = i + 1;
    } else if (trimmed !== "") {
      if (trimmed.startsWith("=") && !hasExpression) {
        hasExpression = true;
        lines[i] = (lines[i] ?? "").replace("=", "");
      }
      break;
    }
  }

  if (startIdx >= lines.length) return ["", hasExpression];
  return [lines.slice(startIdx).join("\n"), hasExpression];
}

/**
 * Strips file headers based on file extension.
 * Dispatches to the appropriate strip function for .js, .sql, and .md files.
 */
export function stripFileHeaders(content: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".js":
      return stripJavaScriptHeaders(content);
    case ".sql":
      return stripSQLHeaders(content);
    case ".md": {
      const [clean, hasExpr] = stripMarkdownHeaders(content);
      return hasExpr ? `=${clean}` : clean;
    }
    default:
      return content;
  }
}

/** Generates the content of an external file with header comments. */
export function generateExternalFileContent(
  nodeName: string,
  workflowName: string,
  code: string,
  fileType: FileType,
): string {
  let content = "";

  switch (fileType) {
    case "js": {
      const cleanCode = stripJavaScriptHeaders(code);
      content = `// Node: ${nodeName}\n// Workflow: ${workflowName}\n\n${cleanCode}`;
      break;
    }
    case "sql": {
      const cleanCode = stripSQLHeaders(code);
      content = `-- Node: ${nodeName}\n-- Workflow: ${workflowName}\n\n${cleanCode}`;
      break;
    }
    case "md": {
      const [cleanCode, hasExpression] = stripMarkdownHeaders(code);
      const prefix = hasExpression ? "=" : "";
      content = `${prefix}<!-- Node: ${nodeName} -->\n<!-- Workflow: ${workflowName} -->\n\n${cleanCode}`;
      break;
    }
  }

  if (!content.endsWith("\n")) {
    content += "\n";
  }
  return content;
}

/**
 * Calculates the relative path from a YAML file to the _subfiles directory.
 */
export function calculateRelativeSubfilesPath(yamlFilePath: string, baseDir: string): string {
  const yamlDir = path.dirname(yamlFilePath);
  let relPath: string;
  try {
    relPath = path.relative(yamlDir, baseDir);
  } catch {
    return `./${SubfilesDir}`;
  }

  if (relPath === "" || relPath === ".") {
    return `./${SubfilesDir}`;
  }

  const posixRel = relPath.split(path.sep).join("/");
  return `${posixRel}/${SubfilesDir}`;
}

/**
 * Generates the file path for an external file, with optional field-specific suffix.
 */
export function generateExternalFilePath(
  workflowID: string,
  workflowName: string,
  nodeName: string,
  fieldName: string,
  fileType: FileType,
  relativeSubfilesPath: string,
): string {
  const sanitizedNode = sanitizeNodeName(nodeName);
  const sanitizedWf = sanitizeNodeName(workflowName);
  const dirName = generateDirnameWithID(sanitizedWf, workflowID);

  let suffix = "";
  switch (fieldName) {
    case "text":
      suffix = "-prompt";
      break;
    case "options.systemMessage":
      suffix = "-system";
      break;
  }

  const prefix = relativeSubfilesPath || `./${SubfilesDir}`;
  return `${prefix}/${dirName}/${sanitizedNode}${suffix}.${fileType}`;
}

/**
 * Converts a JSON workflow to YAML + external files.
 * Writes the YAML file and external files to the output directory.
 * Returns the path to the generated YAML file.
 */
export function generateYamlWorkflow(
  workflow: Workflow,
  outputDir: string,
  yamlFilePath: string,
  lineThreshold = 3,
  charThreshold = 500,
): { yamlPath: string; externalFilePaths: string[] } {
  const workflowID = workflow.id ?? "";

  // Extract external files
  const externalFiles = extractExternalFiles(workflow, lineThreshold, charThreshold);

  // Calculate relative subfiles path
  const relSubfiles = calculateRelativeSubfilesPath(yamlFilePath, outputDir);

  // Build the external file map: nodeID → fieldName → IncludeRef path
  const externalMap: Record<string, Record<string, string>> = {};
  for (const ef of externalFiles) {
    if (!externalMap[ef.nodeID]) {
      externalMap[ef.nodeID] = {};
    }
    externalMap[ef.nodeID]![ef.fieldName] = generateExternalFilePath(
      workflowID,
      workflow.name,
      ef.nodeName,
      ef.fieldName,
      ef.fileType,
      relSubfiles,
    );
  }

  // Build the YAML object with IncludeRef markers
  const yamlObj = buildYamlObject(workflow, externalMap);

  // Write external files
  const writtenPaths: string[] = [];
  for (const ef of externalFiles) {
    const relPath = externalMap[ef.nodeID]?.[ef.fieldName];
    if (!relPath) continue;

    const absPath = path.resolve(path.dirname(yamlFilePath), relPath);
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });

    const content = generateExternalFileContent(
      ef.nodeName,
      workflow.name,
      ef.content,
      ef.fileType,
    );
    fs.writeFileSync(absPath, content, "utf-8");
    writtenPaths.push(absPath);
  }

  // Write the YAML file
  const dumpSchema = createIncludeDumpSchema();
  const yamlContent = yaml.dump(yamlObj, {
    schema: dumpSchema,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  });

  fs.mkdirSync(path.dirname(yamlFilePath), { recursive: true });
  fs.writeFileSync(yamlFilePath, yamlContent, "utf-8");

  return { yamlPath: yamlFilePath, externalFilePaths: writtenPaths };
}

/**
 * Builds a YAML-ready object from a workflow, replacing externalized fields
 * with IncludeRef markers.
 */
export function buildYamlObject(
  workflow: Workflow,
  externalMap: Record<string, Record<string, string>>,
): Record<string, unknown> {
  const nodes = workflow.nodes.map((node) => {
    const nodeExternal = externalMap[node.id];
    if (!nodeExternal || !node.parameters) {
      return { ...node };
    }

    const params = { ...node.parameters };

    for (const [fieldName, refPath] of Object.entries(nodeExternal)) {
      if (fieldName.includes(".")) {
        // Nested field, e.g., "options.systemMessage"
        const [parent, child] = fieldName.split(".", 2) as [string, string];
        const parentObj = params[parent];
        if (parentObj && typeof parentObj === "object") {
          params[parent] = {
            ...(parentObj as Record<string, unknown>),
            [child]: new IncludeRef(refPath),
          };
        }
      } else {
        params[fieldName] = new IncludeRef(refPath);
      }
    }

    return { ...node, parameters: params };
  });

  const result: Record<string, unknown> = {
    id: workflow.id,
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    active: workflow.active,
  };

  // Folder declaration. Written whenever the source knows its folder: a path
  // string for a folder, and an explicit `folder: null` for the project root —
  // the key must not be dropped at the root, because "absent" means "leave the
  // folder untouched" on apply and the assignment would silently stop being
  // managed. (Folder assignments are write-only upstream, so this key is the
  // only record of the workflow's folder a YAML file has.)
  if (workflow.folder !== undefined) {
    result.folder = workflow.folder;
  }

  // Server-assigned timestamp of the state this file was written from. It is
  // never sent back on a write — it exists so `apply` can tell "my definition
  // is based on the current upstream state" from "someone edited this workflow
  // in the n8n UI after I last imported it", which is the difference between an
  // update and an accidental revert. Only emitted when the source carries one,
  // so a hand-written workflow does not acquire a revision it never had.
  // `convert` goes through here too, and carries the stamp across when the
  // source format already had one.
  //
  // js-yaml quotes the ISO string on dump, which matters: an unquoted timestamp
  // is parsed back as a `Date`, not a `string`.
  if (workflow.updatedAt) {
    result.updatedAt = workflow.updatedAt;
  }

  result.nodes = nodes;
  result.connections = workflow.connections;

  if (workflow.settings) {
    result.settings = workflow.settings;
  }

  if (workflow.tags && workflow.tags.length > 0) {
    result.tags = workflow.tags.map((tag) => ({
      ...(tag.id ? { id: tag.id } : {}),
      name: tag.name,
    }));
  }

  return result;
}
