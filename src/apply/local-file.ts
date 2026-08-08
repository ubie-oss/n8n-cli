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

  const existing = /^updatedAt:.*$/m.exec(text);
  if (existing) {
    return `${text.slice(0, existing.index)}${line}${text.slice(existing.index + existing[0].length)}`;
  }

  for (const anchor of YAML_STAMP_ANCHORS) {
    const match = new RegExp(`^${anchor}:.*$`, "m").exec(text);
    if (!match) continue;
    const end = match.index + match[0].length;
    return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
  }

  // No anchor at all: not a shape this writer recognises, so leave it be
  // rather than prepending a key to a file that may not be a workflow.
  return null;
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

  const metaStart = new RegExp(`export\\s+const\\s+${META_EXPORT_NAME}\\s*=\\s*\\{`).exec(text);
  if (!metaStart) return null;

  const bodyStart = metaStart.index + metaStart[0].length;
  const bodyEnd = text.indexOf("\n};", bodyStart);
  if (bodyEnd === -1) return null;

  const body = text.slice(bodyStart, bodyEnd);
  const existing = /^([ \t]*)updatedAt:.*$/m.exec(body);
  if (existing) {
    const replaced = `${existing[1]}updatedAt: ${JSON.stringify(updatedAt)},`;
    const patchedBody = `${body.slice(0, existing.index)}${replaced}${body.slice(existing.index + existing[0].length)}`;
    return `${text.slice(0, bodyStart)}${patchedBody}${text.slice(bodyEnd)}`;
  }

  return `${text.slice(0, bodyStart)}\n  updatedAt: ${JSON.stringify(updatedAt)},${text.slice(bodyStart)}`;
}
