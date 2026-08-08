import fs from "node:fs";
import path from "node:path";

/**
 * Records the server-assigned ID in a credential definition after it is created.
 *
 * Without this a second `credential apply` would create a second credential
 * from the same file — the ID is the only thing linking a definition to what it
 * created, and unlike a workflow file there is no name-based recovery, because
 * n8n allows two credentials to share a name.
 *
 * YAML is patched one line at a time rather than re-serialised: these files are
 * hand-authored and hold the secret *references*, whose comments explaining
 * which vault entry a field points at are the most valuable thing in the file.
 * A regenerate-from-object would drop every one of them.
 *
 * Failures are reported to stderr but not thrown. The credential already exists
 * upstream by this point; turning a failed stamp into an apply error would
 * report a write that actually succeeded as a failure, and the user would have
 * no way to tell the two apart.
 */
export function stampCredentialID(filePath: string, id: string): void {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    warn(filePath, id, err);
    return;
  }

  const patched =
    path.extname(filePath).toLowerCase() === ".json"
      ? patchJSONID(text, id)
      : patchYamlID(text, id);

  if (patched === null) {
    warn(filePath, id, new Error("could not find a place to write the id"));
    return;
  }

  try {
    fs.writeFileSync(filePath, patched);
  } catch (err) {
    warn(filePath, id, err);
  }
}

/** Inserts or replaces the top-level `id` in a JSON definition. */
export function patchJSONID(text: string, id: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // `id` first, so the field a reader looks for is at the top of the file
  // regardless of where it landed in the object.
  const { id: _existing, ...rest } = parsed as Record<string, unknown>;
  return `${JSON.stringify({ id, ...rest }, null, 2)}\n`;
}

/**
 * Replaces a top-level `id:` line, or prepends one.
 *
 * Matches quoted and unquoted keys alike: YAML treats `id:`, `'id':` and `"id":`
 * as the same key, and adding a second one would make the file fail to parse
 * entirely — every later command on it would break from this single write.
 */
export function patchYamlID(text: string, id: string): string {
  const line = `id: ${JSON.stringify(id)}`;
  const existing = /^(['"]?)id\1[ \t]*:.*$/m.exec(text);

  if (existing) {
    return `${text.slice(0, existing.index)}${line}${text.slice(
      existing.index + existing[0].length,
    )}`;
  }

  // Match the file's own line terminator, so a CRLF file does not acquire one
  // lone LF line and show up as churn in a repository that stores CRLF.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return `${line}${eol}${text}`;
}

function warn(filePath: string, id: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `Warning: credential was created (id: ${id}) but ${filePath} could not be updated: ${message}\n` +
      `  Add \`id: ${id}\` to the file by hand, or the next apply will create a duplicate.`,
  );
}
