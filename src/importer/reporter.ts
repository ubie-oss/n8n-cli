import type { ImportResult, OperationType } from "./types.ts";

/** Reports progress during import. */
export function reportProgress(
  current: number,
  total: number,
  _workflowName: string,
  _op: OperationType,
): void {
  process.stderr.write(`Processing: ${current}/${total}...\r`);
}

/** Clears the progress line. */
export function clearProgress(): void {
  process.stderr.write("\r                              \r");
}

/** Reports the final result summary. */
export function reportSummary(result: ImportResult): void {
  clearProgress();
  console.log("Import complete:");
  console.log(`  Created:   ${result.created}`);
  console.log(`  Updated:   ${result.updated}`);
  if (result.renamed > 0) {
    console.log(`  Renamed:   ${result.renamed}`);
  }
  console.log(`  Skipped:   ${result.skipped}`);
  if (result.matched > 0) {
    console.log(`  Matched:   ${result.matched}`);
  }
  if (result.cleanedUp > 0) {
    console.log(`  Cleaned:   ${result.cleanedUp}`);
  }
  console.log(`  Errors:    ${result.errors}`);
  console.log(`  Duration:  ${result.durationMs}ms`);
}

/** Reports dry-run preview. */
export function reportDryRun(result: ImportResult): void {
  clearProgress();
  console.log("Dry-run preview:");

  for (const op of result.operations) {
    switch (op.type) {
      case "create":
        console.log(`  Would create: ${op.localPath} (${op.workflowName})`);
        break;
      case "update":
        console.log(`  Would update: ${op.localPath} (${op.workflowName})`);
        break;
      case "skip":
        console.log(`  Would skip: ${op.localPath} (${op.reason})`);
        break;
      case "cleanup":
        console.log(`  Would cleanup: ${op.localPath} (${op.workflowName})`);
        break;
      case "match":
        console.log(`  Would match: ${op.localPath} (${op.workflowName}) → ID: ${op.workflowID}`);
        break;
      case "rename":
        console.log(`  Would rename: ${op.oldPath} -> ${op.localPath} (${op.workflowName})`);
        break;
      case "error":
        console.log(`  Error: ${op.workflowName} - ${op.reason}`);
        break;
    }
  }

  console.log("\nSummary:");
  console.log(`  Would create:  ${result.created}`);
  console.log(`  Would update:  ${result.updated}`);
  console.log(`  Would skip:    ${result.skipped}`);
  if (result.matched > 0) {
    console.log(`  Would match:   ${result.matched}`);
  }
  if (result.renamed > 0) {
    console.log(`  Would rename:  ${result.renamed}`);
  }
  if (result.cleanedUp > 0) {
    console.log(`  Would cleanup: ${result.cleanedUp}`);
  }
  if (result.errors > 0) {
    console.log(`  Errors:        ${result.errors}`);
  }
}

/** Reports duplicate workflow ID warnings. */
export function reportDuplicates(duplicates: Map<string, string[]>): void {
  if (duplicates.size === 0) return;

  console.error("Warning: Duplicate workflow IDs found:");
  for (const [id, paths] of duplicates) {
    console.error(`  ID '${id}' found in:`);
    for (const p of paths) {
      console.error(`    - ${p}`);
    }
  }
  console.error("");
}
