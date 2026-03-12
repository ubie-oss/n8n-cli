import { createInterface } from "node:readline";
import type { Command } from "commander";
import type { DataTableFilter } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableRowsDeleteCommand(parent: Command): void {
  parent
    .command("delete")
    .description("Delete rows from a data table")
    .argument("<dataTableId>", "Data table ID")
    .requiredOption("--filter <json>", "Filter as JSON string (required)")
    .option("--return-data", "Return deleted data")
    .option("--dry-run", "Dry run without making changes")
    .option("--force", "Skip confirmation prompt")
    .action(async (dataTableId: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent?.parent!);

      let filter: DataTableFilter;
      try {
        filter = JSON.parse(options.filter as string);
      } catch {
        console.error("Error: Invalid JSON for --filter option");
        process.exit(1);
      }

      if (!options.force && !options.dryRun) {
        const confirmed = await confirmDelete("matching rows");
        if (!confirmed) {
          console.log("Deletion cancelled");
          return;
        }
      }

      const result = await ctx.dataTableService.deleteRows(dataTableId, filter, {
        returnData: options.returnData as boolean | undefined,
        dryRun: options.dryRun as boolean | undefined,
      });

      if (options.dryRun) {
        console.log("Dry run result:");
      } else {
        console.log("Rows deleted successfully");
      }
      formatJSON(result, true);
    });
}

function confirmDelete(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`Are you sure you want to delete ${name}? [y/N]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}
