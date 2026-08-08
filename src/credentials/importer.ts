import fs from "node:fs";
import path from "node:path";
import type { CredentialService } from "@/api/credential-service.ts";
import type { Credential } from "@/api/types.ts";
import { sanitizeFilename } from "@/importer/writer.ts";
import { scanCredentialDirectory } from "./scanner.ts";

/** What an import did, or would do, to one credential. */
export interface CredentialImportOperation {
  credentialID: string;
  credentialName: string;
  credentialType: string;
  type: "create" | "skip";
  localPath: string;
  reason: string;
}

/** Aggregated result of a credential import run. */
export interface CredentialImportResult {
  operations: CredentialImportOperation[];
  dryRun: boolean;
  created: number;
  skipped: number;
}

/** CredentialImportOptions configures `credential import`. */
export interface CredentialImportOptions {
  directory: string;
  dryRun: boolean;
  /** Restrict the run to these credential IDs. */
  ids: string[];
}

/**
 * Writes a local definition file for every credential on the server that does
 * not have one yet.
 *
 * Scaffolding, not a sync. The public API marks credential data write-only, so
 * an import can recover a credential's identity — id, name, type — and nothing
 * about its values; there is no version of this that round-trips. Existing
 * files are therefore never rewritten: they hold the secret references, which
 * are the only part of a credential definition worth keeping, and no server
 * response could reproduce them.
 */
export async function importCredentials(
  credentialService: CredentialService,
  opts: CredentialImportOptions,
): Promise<CredentialImportResult> {
  const result: CredentialImportResult = {
    operations: [],
    dryRun: opts.dryRun,
    created: 0,
    skipped: 0,
  };

  const knownIDs = new Set<string>();
  for (const file of scanCredentialDirectory(opts.directory)) {
    if (file.definition?.id) knownIDs.add(file.definition.id);
  }

  const remote = await credentialService.listAllCredentials();

  for (const credential of remote) {
    if (!credential.id) continue;
    if (opts.ids.length > 0 && !opts.ids.includes(credential.id)) continue;

    if (knownIDs.has(credential.id)) {
      result.operations.push({
        credentialID: credential.id,
        credentialName: credential.name,
        credentialType: credential.type,
        type: "skip",
        localPath: "",
        reason: "already defined locally",
      });
      result.skipped++;
      continue;
    }

    const target = credentialFilePath(opts.directory, credential);
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderScaffold(credential), "utf-8");
    }

    result.operations.push({
      credentialID: credential.id,
      credentialName: credential.name,
      credentialType: credential.type,
      type: "create",
      localPath: target,
      reason: "",
    });
    result.created++;
  }

  return result;
}

/** Builds the path a credential's definition file gets. */
export function credentialFilePath(directory: string, credential: Credential): string {
  const base = sanitizeFilename(credential.name);
  // The ID is in the filename for the same reason it is in a workflow's: it is
  // what lets a later scan pair a file with its credential without opening
  // every file in the directory.
  return path.join(directory, `${base}.${credential.id}.yaml`);
}

/**
 * Renders the scaffold for a credential whose values are unknown.
 *
 * Emitted as hand-written text rather than via `yaml.dump`, because the
 * comments are the point: a file with an empty `data` block and no explanation
 * looks like a credential whose values were lost, when in fact the server never
 * had any to give. The commented examples double as the reference syntax
 * documentation at the exact moment someone needs it.
 */
export function renderScaffold(credential: Credential): string {
  return [
    `# Credential definition for "${credential.name}".`,
    "#",
    "# Values are NOT included: the n8n public API marks credential data",
    "# write-only and returns it from no endpoint, so this file starts empty and",
    "# the values below are whatever you put here.",
    "#",
    "# Fill in `data` with the fields this credential type expects — run",
    `#   n8n-cli credential schema ${credential.type}`,
    "# to see them — then apply with `n8n-cli credential apply`.",
    "#",
    "# A value may be written as a secret reference instead of a literal:",
    "#   gcp-sm://<project>/<secret>          Google Cloud Secret Manager (latest version)",
    "#   gcp-sm://<project>/<secret>/<version>",
    "#   env://<VARIABLE_NAME>                process environment",
    "# References are resolved at apply time and never written back to this file.",
    `id: ${JSON.stringify(credential.id ?? "")}`,
    `name: ${JSON.stringify(credential.name)}`,
    `type: ${JSON.stringify(credential.type)}`,
    "data: {}",
    "",
  ].join("\n");
}
