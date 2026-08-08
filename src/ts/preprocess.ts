import * as acorn from "acorn";

/**
 * The n8n workflow SDK's AST interpreter accepts a deliberately small subset of
 * JavaScript: `const` declarations, expression statements and a single
 * `export default`. It rejects anything else — including the
 * `import { workflow, node } from "@n8n/workflow-sdk"` line that makes a
 * workflow file type-check in an editor, and every TypeScript-only construct.
 *
 * So a `.ts` workflow authored by a human (or emitted by `n8n-cli import`) has
 * to be reduced to that subset before it reaches the SDK. This module does
 * three things, in order:
 *
 *   1. strips TypeScript syntax (type annotations, `as`, `satisfies`,
 *      `import type`) via Bun's transpiler,
 *   2. lifts out the optional `export const meta = { ... }` block, which carries
 *      the workflow fields the SDK has no representation for, and
 *   3. strips the remaining module-level import/re-export statements.
 *
 * Everything else is passed through untouched — in particular template literals
 * keep their `${...}` spans, because the SDK escapes n8n runtime variables like
 * `${$json}` itself during parsing.
 */

/** Name of the optional metadata export recognised in `.ts` workflow files. */
export const META_EXPORT_NAME = "meta";

/**
 * Workflow fields that `@n8n/workflow-sdk`'s `WorkflowJSON` cannot express but
 * n8n-cli needs — `active` drives activation on apply, `tags` drives the
 * `--tag` filter and auto-tagging.
 */
export interface TsWorkflowMeta {
  active?: boolean;
  isArchived?: boolean;
  tags?: string[];
  /**
   * Node IDs keyed by node name.
   *
   * The SDK's builder has no field for a node ID and mints a random UUID on
   * every parse, so without this the IDs of a workflow would change every time
   * it was read. Recording them here keeps a generated file an exact
   * representation of the workflow it came from.
   */
  nodeIds?: Record<string, string>;
  /**
   * Upstream `updatedAt` at the time the file was written.
   *
   * `import` skips a workflow whose local copy is at least as new as the remote
   * one. Without this field every import would rewrite the file — discarding the
   * comments, variable names and formatting that are the whole point of keeping
   * a workflow as code.
   */
  updatedAt?: string;
}

/** A `.ts` workflow reduced to the subset the SDK interpreter accepts. */
export interface PreprocessedTsWorkflow {
  /**
   * SDK-parseable code.
   *
   * Line numbers are close to, but not identical with, the original file: Bun's
   * transpiler reprints the source, so anything it removes shifts later lines.
   * Error messages therefore quote the offending construct rather than relying
   * on a line number alone.
   */
  code: string;
  /** Contents of `export const meta`, or an empty object when absent. */
  meta: TsWorkflowMeta;
}

/** Error thrown when a `.ts` workflow cannot be reduced to the SDK subset. */
export class TsPreprocessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsPreprocessError";
  }
}

/** Strips TypeScript-only syntax, leaving plain JavaScript. */
function stripTypes(source: string): string {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  try {
    return transpiler.transformSync(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TsPreprocessError(`TypeScript syntax error: ${msg}`);
  }
}

/**
 * Evaluates a static literal expression (object, array, string, number,
 * boolean, null, negated number) to its JavaScript value.
 *
 * Deliberately not a general evaluator: the metadata block is configuration, so
 * anything with a runtime component is a mistake worth reporting rather than
 * guessing at.
 */
function evaluateLiteral(node: acorn.Expression): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "ArrayExpression":
      return node.elements.map((el) => {
        if (el == null || el.type === "SpreadElement") {
          throw new TsPreprocessError(`${META_EXPORT_NAME} must contain only literal values`);
        }
        return evaluateLiteral(el);
      });
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property" || prop.computed) {
          throw new TsPreprocessError(`${META_EXPORT_NAME} must contain only literal values`);
        }
        const key =
          prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key.type === "Literal"
              ? String(prop.key.value)
              : null;
        if (key == null) {
          throw new TsPreprocessError(`${META_EXPORT_NAME} has an unsupported property key`);
        }
        out[key] = evaluateLiteral(prop.value as acorn.Expression);
      }
      return out;
    }
    case "UnaryExpression":
      if (node.operator === "-") {
        const inner = evaluateLiteral(node.argument);
        if (typeof inner === "number") return -inner;
      }
      throw new TsPreprocessError(`${META_EXPORT_NAME} must contain only literal values`);
    default:
      throw new TsPreprocessError(`${META_EXPORT_NAME} must contain only literal values`);
  }
}

/** Narrows a raw metadata object to the fields n8n-cli understands. */
function coerceMeta(raw: unknown): TsWorkflowMeta {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TsPreprocessError(`${META_EXPORT_NAME} must be an object literal`);
  }
  const obj = raw as Record<string, unknown>;
  const meta: TsWorkflowMeta = {};

  if (obj.active !== undefined) {
    if (typeof obj.active !== "boolean") {
      throw new TsPreprocessError(`${META_EXPORT_NAME}.active must be a boolean`);
    }
    meta.active = obj.active;
  }
  if (obj.isArchived !== undefined) {
    if (typeof obj.isArchived !== "boolean") {
      throw new TsPreprocessError(`${META_EXPORT_NAME}.isArchived must be a boolean`);
    }
    meta.isArchived = obj.isArchived;
  }
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some((t) => typeof t !== "string")) {
      throw new TsPreprocessError(`${META_EXPORT_NAME}.tags must be an array of strings`);
    }
    meta.tags = obj.tags as string[];
  }
  if (obj.updatedAt !== undefined) {
    if (typeof obj.updatedAt !== "string") {
      throw new TsPreprocessError(`${META_EXPORT_NAME}.updatedAt must be a string`);
    }
    meta.updatedAt = obj.updatedAt;
  }
  if (obj.nodeIds !== undefined) {
    const raw = obj.nodeIds;
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TsPreprocessError(`${META_EXPORT_NAME}.nodeIds must be an object`);
    }
    const nodeIds: Record<string, string> = {};
    for (const [name, id] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof id !== "string") {
        throw new TsPreprocessError(`${META_EXPORT_NAME}.nodeIds values must be strings`);
      }
      nodeIds[name] = id;
    }
    meta.nodeIds = nodeIds;
  }

  return meta;
}

/** True when a statement is `export const meta = ...`. */
function isMetaExport(stmt: acorn.Statement | acorn.ModuleDeclaration): boolean {
  return (
    stmt.type === "ExportNamedDeclaration" &&
    stmt.declaration?.type === "VariableDeclaration" &&
    stmt.declaration.declarations.some(
      (d) => d.id.type === "Identifier" && d.id.name === META_EXPORT_NAME,
    )
  );
}

/** Reads the value of `export const meta = ...` from a statement. */
function readMetaExport(stmt: acorn.ExportNamedDeclaration): TsWorkflowMeta {
  const decl = stmt.declaration as acorn.VariableDeclaration;
  // The whole statement is removed, so a second declarator sharing it would be
  // silently deleted along with the metadata. Refuse rather than do that.
  if (decl.declarations.length > 1) {
    throw new TsPreprocessError(
      `${META_EXPORT_NAME} must be declared on its own, not alongside other exports`,
    );
  }
  const declarator = decl.declarations.find(
    (d) => d.id.type === "Identifier" && d.id.name === META_EXPORT_NAME,
  );
  if (!declarator?.init) {
    throw new TsPreprocessError(`${META_EXPORT_NAME} must be initialised with an object literal`);
  }
  return coerceMeta(evaluateLiteral(declarator.init));
}

/**
 * Removes module-level imports, re-exports and the metadata export.
 *
 * Uses acorn rather than a regex so that multi-line statements, and strings that
 * merely look like imports, are handled correctly. Statements are blanked in
 * place (spaces, newlines preserved) instead of deleted, so that the code handed
 * to the SDK stays line-aligned with what acorn parsed here.
 */
function stripNonSdkStatements(code: string): PreprocessedTsWorkflow {
  let program: acorn.Program;
  try {
    program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TsPreprocessError(`syntax error: ${msg}`);
  }

  let meta: TsWorkflowMeta = {};

  // Offsets from acorn are UTF-16 indices, so rebuild by slicing rather than
  // iterating code points — otherwise any astral character (an emoji in a node
  // name, say) would shift every subsequent offset.
  let result = "";
  let cursor = 0;
  for (const stmt of program.body) {
    const isImport = stmt.type === "ImportDeclaration";
    // `export { x } from "..."` / `export * from "..."` — re-exports only.
    // A bare `export default` must survive: it is how the SDK returns the workflow.
    const isReExport =
      (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportAllDeclaration") &&
      stmt.source != null;
    const isMeta = isMetaExport(stmt);

    if (isMeta) {
      meta = readMetaExport(stmt as acorn.ExportNamedDeclaration);
    } else if (!isImport && !isReExport) {
      continue;
    }

    result += code.slice(cursor, stmt.start);
    result += code.slice(stmt.start, stmt.end).replace(/[^\n]/g, " ");
    cursor = stmt.end;
  }
  result += code.slice(cursor);

  return { code: result, meta };
}

/**
 * Reduces a `.ts` workflow file to the JavaScript subset the SDK interpreter
 * accepts, and lifts out its metadata block.
 *
 * Safe to call on code that is already in that subset.
 */
export function preprocessTsWorkflow(source: string): PreprocessedTsWorkflow {
  return stripNonSdkStatements(stripTypes(source));
}
