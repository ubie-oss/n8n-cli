import path from "node:path";
import type {
  ApplyOperation,
  ApplyResult,
  DuplicateWarning,
  FieldDiff,
  OperationType,
} from "./types.ts";

/** Reports apply results to stdout. */
export function report(result: ApplyResult): void {
  if (result.operations.length === 0) {
    console.log("No workflow files found");
    return;
  }

  // Print duplicate warnings first
  if (result.warnings.length > 0) {
    printWarningsSection(result.warnings);
  }

  // Group operations by type
  const creates = filterByOp(result.operations, "create");
  const updates = filterByOp(result.operations, "update");
  const skips = filterByOp(result.operations, "skip");
  const conflicts = filterByOp(result.operations, "conflict");
  const errors = filterByOp(result.operations, "error");

  if (creates.length > 0) printCreateSection(creates);
  if (updates.length > 0) printUpdateSection(updates);
  if (skips.length > 0) printSkipSection(skips);
  if (conflicts.length > 0) printConflictSection(conflicts);
  if (errors.length > 0) printErrorSection(errors);

  printSummary(result);
}

function filterByOp(ops: ApplyOperation[], type: OperationType): ApplyOperation[] {
  return ops.filter((op) => op.operation === type);
}

function plural(n: number): string {
  return n !== 1 ? "s" : "";
}

function printCreateSection(ops: ApplyOperation[]): void {
  console.log(`\n=== CREATE (${ops.length} workflow${plural(ops.length)}) ===`);
  for (const op of ops) {
    console.log(`  + ${path.basename(op.file)} (name: "${op.workflowName}")`);
    printTagsAndProjectInfo(op);
  }
}

function printUpdateSection(ops: ApplyOperation[]): void {
  console.log(`\n=== UPDATE (${ops.length} workflow${plural(ops.length)}) ===`);
  for (const op of ops) {
    const filename = path.basename(op.file);
    const threeWayTag = op.threeWayUsed ? " [3-way]" : "";
    if (op.forced) {
      console.log(`  ~ ${filename} (id: ${op.workflowID}) [FORCED]${threeWayTag}`);
      console.log("    Warning: Remote was newer, overwritten with --force");
    } else {
      console.log(`  ~ ${filename} (id: ${op.workflowID})${threeWayTag}`);
    }
    printThreeWayInfo(op);
    if (op.diff) {
      for (const field of op.diff.fields) {
        printFieldDiff(field);
      }
    }
    printTagsAndProjectInfo(op);
  }
}

function printThreeWayInfo(op: ApplyOperation): void {
  if (!op.threeWayUsed) return;
  if (op.threeWayReason) {
    console.log(`    [3-way] ${op.threeWayReason}`);
  }
  if (op.baseToLocalFields.length > 0) {
    console.log(`    Base→Local: ${JSON.stringify(op.baseToLocalFields)}`);
  }
  if (op.baseToRemoteFields.length > 0) {
    console.log(`    Base→Remote: ${JSON.stringify(op.baseToRemoteFields)}`);
  }
}

function printTagsAndProjectInfo(op: ApplyOperation): void {
  if (op.tagsAdded.length > 0) {
    console.log(`    + tags: ${JSON.stringify(op.tagsAdded)}`);
  }
  if (op.projectMoved) {
    if (op.fromProject) {
      console.log(`    -> project: ${op.fromProject} -> ${op.toProject}`);
    } else {
      console.log(`    -> project: ${op.toProject}`);
    }
  }

  // Activation info
  if (op.activated === true) {
    console.log("    ✓ Activated");
  } else if (op.activated === false) {
    console.log("    ✓ Deactivated");
  }

  if (op.activationError) {
    console.log(`    ⚠ Activation error: ${op.activationError.message}`);
  }
}

function printFieldDiff(field: FieldDiff): void {
  switch (field.field) {
    case "name":
      console.log(`    - name: "${field.oldValue}" → "${field.newValue}"`);
      break;
    case "active":
      console.log(`    - active: ${field.oldValue} → ${field.newValue}`);
      break;
    case "nodes":
      console.log(`    - nodes: ${field.oldValue} → ${field.newValue} nodes`);
      break;
    case "connections":
      console.log(`    - connections: ${field.oldValue} → ${field.newValue} connections`);
      break;
    case "settings":
      console.log("    - settings: modified");
      break;
    default:
      console.log(`    - ${field.field}: ${field.oldValue} → ${field.newValue}`);
      break;
  }
}

function printSkipSection(ops: ApplyOperation[]): void {
  console.log(`\n=== SKIP (${ops.length} workflow${plural(ops.length)}) ===`);
  for (const op of ops) {
    const threeWayTag = op.threeWayUsed ? " [3-way]" : "";
    console.log(`  = ${path.basename(op.file)} (no changes)${threeWayTag}`);
    printThreeWayInfo(op);
  }
}

function printConflictSection(ops: ApplyOperation[]): void {
  console.log(`\n=== CONFLICT (${ops.length} workflow${plural(ops.length)}) ===`);
  for (const op of ops) {
    const workflowID = op.workflowID || "unknown";
    const threeWayTag = op.threeWayUsed ? " [3-way]" : "";
    console.log(
      `  ! ${path.basename(op.file)} (id: ${workflowID}) (use --force to override)${threeWayTag}`,
    );
    printThreeWayInfo(op);
  }
}

function printErrorSection(ops: ApplyOperation[]): void {
  console.log(`\n=== ERROR (${ops.length} workflow${plural(ops.length)}) ===`);
  for (const op of ops) {
    console.log(`  ✗ ${path.basename(op.file)}: ${op.error?.message ?? "unknown error"}`);
  }
}

function printWarningsSection(warnings: DuplicateWarning[]): void {
  console.log(`\n=== WARNING: POTENTIAL DUPLICATES (${warnings.length} found) ===`);
  for (const w of warnings) {
    const activeStr = w.remoteActive ? " [ACTIVE]" : "";
    console.log(
      `  ⚠ ${path.basename(w.localPath)}: workflow "${w.localName}" already exists remotely (id: ${w.remoteID})${activeStr}`,
    );
  }
  console.log();
  console.log("  Hint: Use --force to create duplicates anyway, or add the");
  console.log("        remote workflow ID to your local file to update instead.");
}

function printSummary(result: ApplyResult): void {
  console.log();
  const prefix = result.dryRun ? "Summary (dry-run): " : "Summary: ";

  const parts: string[] = [];
  if (result.createCount > 0) parts.push(`${result.createCount} to create`);
  if (result.updateCount > 0) parts.push(`${result.updateCount} to update`);
  if (result.skipCount > 0) parts.push(`${result.skipCount} unchanged`);
  if (result.conflictCount > 0) parts.push(`${result.conflictCount} conflicts`);
  if (result.errorCount > 0) parts.push(`${result.errorCount} errors`);
  if (result.warningCount > 0) parts.push(`${result.warningCount} warnings`);

  if (parts.length === 0) {
    console.log(`${prefix}no workflows processed`);
  } else {
    console.log(`${prefix}${parts.join(", ")}`);
  }
}
