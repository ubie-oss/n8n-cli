import type { Command } from "commander";
import type { DataTableFilter } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableRowsUpdateCommand(parent: Command): void {
  parent
    .command("update")
    .description("Update rows in a data table")
    .argument("<dataTableId>", "Data table ID")
    .requiredOption("--filter <json>", "Filter as JSON string")
    .requiredOption("-d, --data <json>", "Update data as JSON object")
    .option("--return-data", "Return updated data")
    .option("--dry-run", "Dry run without making changes")
    .action(async (dataTableId: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent?.parent!);

      let filter: DataTableFilter;
      try {
        filter = JSON.parse(options.filter as string);
      } catch {
        console.error("Error: Invalid JSON for --filter option");
        process.exit(1);
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(options.data as string);
      } catch {
        console.error("Error: Invalid JSON for --data option");
        process.exit(1);
      }

      const result = await ctx.dataTableService.updateRows(dataTableId, {
        filter,
        data,
        returnData: options.returnData as boolean | undefined,
        dryRun: options.dryRun as boolean | undefined,
      });

      if (options.dryRun) {
        console.log("Dry run result:");
      } else {
        console.log("Rows updated successfully");
      }
      formatJSON(result, true);
    });
}
