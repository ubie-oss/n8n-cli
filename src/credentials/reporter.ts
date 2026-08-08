import path from "node:path";
import type { CredentialImportResult } from "./importer.ts";
import type { CredentialApplyResult, CredentialOperation } from "./types.ts";

/**
 * Prints the outcome of a credential apply.
 *
 * Nothing here ever prints a credential value, resolved or otherwise. Secret
 * references are printed — they are locators, not secrets, and seeing which
 * vault entry a field points at is the main thing a reviewer needs from this
 * output.
 */
export function reportCredentialApply(result: CredentialApplyResult): void {
  if (result.operations.length === 0) {
    console.log("No credential definition files found");
    return;
  }

  const byType = (type: CredentialOperation["operation"]) =>
    result.operations.filter((op) => op.operation === type);

  const creates = byType("create");
  const updates = byType("update");
  const errors = byType("error");

  if (creates.length > 0) {
    console.log(`\n=== CREATE (${creates.length} credential${plural(creates.length)}) ===`);
    for (const op of creates) {
      console.log(
        `  + ${path.basename(op.file)} (name: "${op.credentialName}", ${op.credentialType})`,
      );
      printSecretRefs(op);
      if (op.duplicateOf) {
        console.log(
          `    ⚠ upstream already has a credential named "${op.duplicateOf.name}" (id: ${op.duplicateOf.id})`,
        );
      }
    }
  }

  if (updates.length > 0) {
    console.log(`\n=== UPDATE (${updates.length} credential${plural(updates.length)}) ===`);
    for (const op of updates) {
      console.log(`  ~ ${path.basename(op.file)} (id: ${op.credentialID})`);
      printSecretRefs(op);
    }
  }

  if (errors.length > 0) {
    console.log(`\n=== ERROR (${errors.length} credential${plural(errors.length)}) ===`);
    for (const op of errors) {
      console.log(`  ✗ ${path.basename(op.file)}: ${op.error?.message ?? "unknown error"}`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(
    `  ${result.dryRun ? "Would create" : "Created"}: ${result.createCount}, ` +
      `${result.dryRun ? "would update" : "updated"}: ${result.updateCount}, ` +
      `errors: ${result.errorCount}`,
  );
  if (result.dryRun) {
    console.log("  (dry run — no credential was written and no secret was fetched)");
  }
}

/** Prints the outcome of a credential import. */
export function reportCredentialImport(result: CredentialImportResult): void {
  const creates = result.operations.filter((op) => op.type === "create");

  if (creates.length > 0) {
    console.log(`\n=== CREATE (${creates.length} file${plural(creates.length)}) ===`);
    for (const op of creates) {
      console.log(`  + ${op.localPath} (name: "${op.credentialName}", ${op.credentialType})`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(
    `  ${result.dryRun ? "Would write" : "Wrote"}: ${result.created}, skipped: ${result.skipped}`,
  );
  if (result.created > 0) {
    console.log("  Credential values are never returned by the n8n API — fill in `data` yourself.");
  }
}

/**
 * Lists the fields that hold secret references.
 *
 * On a dry run this is the whole point of the command: it tells the user which
 * vault entries an apply is about to read, before it reads any of them.
 */
function printSecretRefs(op: CredentialOperation): void {
  for (const ref of op.secretRefs) {
    console.log(`    → data.${ref.path}: ${ref.raw}`);
  }
}

function plural(n: number): string {
  return n !== 1 ? "s" : "";
}
