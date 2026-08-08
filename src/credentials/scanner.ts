import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { CredentialDefinition, CredentialFile } from "./types.ts";

/** File extensions recognised as credential definitions. */
const CREDENTIAL_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

/**
 * Reads every credential definition under a directory.
 *
 * Unreadable and malformed files become entries carrying an `error` rather than
 * aborting the scan, so one bad file does not hide the state of every other
 * credential in the directory — the same contract the workflow scanner has.
 */
export function scanCredentialDirectory(directory: string): CredentialFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files: CredentialFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!CREDENTIAL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    // Bun's Dirent carries the directory it was found in; joining with it is
    // what makes the recursive walk return usable paths.
    files.push(loadCredentialFile(path.join(entry.parentPath ?? directory, entry.name)));
  }

  // Sorted so a run's output — and the order credentials are created in — does
  // not depend on the filesystem's iteration order.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads and validates one credential definition file. */
export function loadCredentialFile(filePath: string): CredentialFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return { path: filePath, error: err instanceof Error ? err : new Error(String(err)) };
  }

  let parsed: unknown;
  try {
    // `yaml.load` handles JSON too — JSON is a subset of YAML — so one parser
    // covers both extensions and there is no way for the two paths to disagree
    // about what a file means.
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      path: filePath,
      error: new Error(`failed to parse: ${err instanceof Error ? err.message : String(err)}`),
    };
  }

  try {
    return { path: filePath, definition: coerceDefinition(parsed) };
  } catch (err) {
    return { path: filePath, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Narrows a parsed file to a credential definition, or explains why it is not one. */
export function coerceDefinition(raw: unknown): CredentialDefinition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("credential definition must be a mapping with name and type");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name === "") {
    throw new Error("credential definition requires a non-empty `name`");
  }
  if (typeof obj.type !== "string" || obj.type === "") {
    throw new Error("credential definition requires a non-empty `type` (e.g. slackApi)");
  }
  if (obj.id !== undefined && typeof obj.id !== "string") {
    throw new Error("`id` must be a string");
  }
  if (obj.data !== undefined && (obj.data === null || typeof obj.data !== "object")) {
    throw new Error("`data` must be a mapping of credential fields");
  }

  const definition: CredentialDefinition = { name: obj.name, type: obj.type };
  if (obj.id) definition.id = obj.id;
  if (obj.data !== undefined) definition.data = obj.data as Record<string, unknown>;
  return definition;
}
