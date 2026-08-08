import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { META_EXPORT_NAME } from "@/ts/preprocess.ts";

/**
 * Writes back what the server decided, after a successful create or update.
 *
 * The important field is `updatedAt`. A definition carries the upstream
 * timestamp it was written from, and `apply` compares that against the live
 * workflow to tell an intentional update from an accidental revert of someone
 * else's UI edit. Leaving a stale stamp behind after a successful write would
 * make the *next* edit of the same file look like a conflict, so every format
 * has to be re-stamped — not just JSON, which is all this used to handle.
 *
 * YAML and TypeScript are rewritten surgically, one line at a time. They are
 * authored files: `!include` refs, comments and hand-written builder code do
 * not survive a regenerate-from-remote, so the stamp is patched in place and
 * everything else is left exactly as the author wrote it.
 *
 * Failures are swallowed throughout. The remote write already succeeded; a
 * local file that could not be re-stamped is a stale timestamp, not a lost
 * change, and turning it into an apply error would be a worse outcome.
 */
export async function updateLocalWorkflowFile(filePath: string, workflow: Workflow): Promise<void> {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json":
      updateJSONFile(filePath, workflow);
      return;
    case ".yaml":
    case ".yml":
      patchInPlace(filePath, (text) => patchYamlStamp(text, workflow.updatedAt));
      return;
    case ".ts":
      patchInPlace(filePath, (text) => patchTsStamp(text, workflow.updatedAt));
      return;
    default:
      return;
  }
}

/** Reads, transforms and writes a file, doing nothing when anything fails. */
function patchInPlace(filePath: string, transform: (text: string) => string | null): void {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const patched = transform(text);
  if (patched === null || patched === text) return;

  try {
    fs.writeFileSync(filePath, patched);
  } catch {
    // see the note on updateLocalWorkflowFile
  }
}

/**
 * JSON holds the whole server object, so the server's view of identity and
 * state is written back alongside the timestamps.
 */
function updateJSONFile(filePath: string, workflow: Workflow): void {
  patchInPlace(filePath, (data) => {
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }

    existing.id = workflow.id;
    existing.name = workflow.name;
    existing.active = workflow.active;
    if (workflow.updatedAt) existing.updatedAt = workflow.updatedAt;
    if (workflow.createdAt) existing.createdAt = workflow.createdAt;

    return `${JSON.stringify(existing, null, 2)}\n`;
  });
}

/** Top-level keys the stamp is inserted after, best anchor first. */
const YAML_STAMP_ANCHORS = ["active", "name", "id"];

/**
 * Matches a top-level mapping key, quoted or not.
 *
 * YAML lets a key be written `updatedAt:`, `'updatedAt':` or `"updatedAt":`,
 * and all three mean the same key. Recognising only the bare form would make
 * the writer *add* a second one, and a duplicate mapping key is a parse error
 * — the file would stop loading entirely, in every command, from one silent
 * write.
 */
function yamlKeyPattern(key: string): RegExp {
  return new RegExp(`^(['"]?)${key}\\1[ \\t]*:.*$`, "m");
}

/**
 * Replaces the top-level `updatedAt:` line, or inserts one after the first
 * anchor key present.
 *
 * The value is single-quoted to match what js-yaml emits, and for a reason
 * beyond consistency: an unquoted ISO timestamp is parsed back as a `Date`
 * rather than a `string`, which every consumer of `Workflow.updatedAt` would
 * then have to handle.
 */
export function patchYamlStamp(text: string, updatedAt: string | undefined): string | null {
  if (!updatedAt) return null;

  const line = `updatedAt: '${updatedAt.replaceAll("'", "''")}'`;

  const existing = yamlKeyPattern("updatedAt").exec(text);
  if (existing) {
    return `${text.slice(0, existing.index)}${line}${text.slice(existing.index + existing[0].length)}`;
  }

  for (const anchor of YAML_STAMP_ANCHORS) {
    const match = yamlKeyPattern(anchor).exec(text);
    if (!match) continue;
    const end = match.index + match[0].length;
    return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
  }

  // No anchor at all: not a shape this writer recognises, so leave it be
  // rather than prepending a key to a file that may not be a workflow.
  return null;
}

/**
 * Locates the body of the first `meta` object literal: the offsets just inside
 * its braces, or null when the file has no such export.
 *
 * The end is found by matching braces rather than by looking for a closing
 * line, because `.ts` workflows are hand-authored and `meta` is not always
 * spread over multiple lines. Scanning for the first `\n};` would run past a
 * single-line `meta` and swallow the workflow code after it, putting an
 * `updatedAt:` in some node's parameters within reach of the rewrite below.
 *
 * Strings and comments are skipped so a brace inside either cannot end the
 * literal early.
 */
function findMetaBody(text: string): { start: number; end: number } | null {
  // The type annotation is optional: `export const meta: TsWorkflowMeta = {`
  // is as valid an input as the unannotated form `import` writes.
  const opening = new RegExp(`export\\s+const\\s+${META_EXPORT_NAME}\\s*(?::[^=]+)?=\\s*\\{`).exec(
    text,
  );
  if (!opening) return null;

  const start = opening.index + opening[0].length;
  let depth = 1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }

  // Unbalanced braces: the file does not parse anyway, so leave it alone.
  return null;
}

/** Returns the index of the closing quote of the string starting at `open`. */
function skipString(text: string, open: number): number {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return text.length;
}

/**
 * Replaces `updatedAt` inside the `meta` export, or inserts it as the first
 * entry when the file has a `meta` block without one.
 *
 * Only the first `meta` object literal is considered — a `.ts` workflow has
 * exactly one, and matching further down the file would rewrite a node
 * parameter that happens to be named the same.
 */
export function patchTsStamp(text: string, updatedAt: string | undefined): string | null {
  if (!updatedAt) return null;

  const meta = findMetaBody(text);
  if (!meta) return null;

  const value = findStampValue(text, meta);
  // The key is there but its value is not a plain string literal. Inserting
  // would produce a duplicate property, and in an object literal the *last*
  // one wins — so the file would keep reporting its old revision forever while
  // looking like it had been updated. Leave it untouched instead.
  if (value === "unparseable") return null;
  if (value) {
    return `${text.slice(0, value.start)}${JSON.stringify(updatedAt)}${text.slice(value.end)}`;
  }

  return `${text.slice(0, meta.start)}\n  updatedAt: ${JSON.stringify(updatedAt)},${text.slice(meta.start)}`;
}

/**
 * Finds the string literal assigned to `meta.updatedAt`.
 *
 * Returns null when the block declares no such property, and `"unparseable"`
 * when it declares one whose value this writer will not touch. The caller must
 * treat those two differently: only the first is safe to insert into.
 *
 * Only properties of `meta` itself count. `nodeIds` is keyed by node name, and
 * a node called "updatedAt" would otherwise have its ID overwritten with a
 * timestamp. Replacing just the value also means the author's key spelling,
 * indentation and quote style survive.
 */
function findStampValue(
  text: string,
  meta: { start: number; end: number },
): { start: number; end: number } | "unparseable" | null {
  let depth = 0;

  for (let i = meta.start; i < meta.end; i++) {
    const ch = text[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      const close = skipString(text, i);
      // A quoted key is still a key: `"updatedAt": "..."` declares exactly the
      // same property as the bare form, and skipping past it would make the
      // caller add a second one.
      const keyEnd = depth === 0 ? matchQuotedKey(text, i, close) : null;
      if (keyEnd === null) {
        i = close;
        continue;
      }
      return readStampValue(text, keyEnd);
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? meta.end : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? meta.end : close + 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;

    if (!text.startsWith("updatedAt", i)) continue;
    // Must be a whole word, so `lastUpdatedAt` does not match.
    if (i > meta.start && /[\w$]/.test(text[i - 1] ?? "")) continue;

    const colon = /^\s*:\s*/.exec(text.slice(i + "updatedAt".length));
    if (!colon) continue;

    return readStampValue(text, i + "updatedAt".length + colon[0].length);
  }

  return null;
}

/**
 * When the string spanning `[open, close]` is the quoted key `"updatedAt"`,
 * returns the offset just past its colon. Otherwise null.
 */
function matchQuotedKey(text: string, open: number, close: number): number | null {
  if (text.slice(open + 1, close) !== "updatedAt") return null;
  const colon = /^\s*:\s*/.exec(text.slice(close + 1));
  return colon ? close + 1 + colon[0].length : null;
}

/** Reads the string literal at `start`, or reports that it is not one. */
function readStampValue(
  text: string,
  start: number,
): { start: number; end: number } | "unparseable" {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return "unparseable";
  return { start, end: skipString(text, start) + 1 };
}
