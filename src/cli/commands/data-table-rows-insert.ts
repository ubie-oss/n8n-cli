import type { Command } from "commander";
import { formatJSON } from "@/cli/output/json.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableRowsInsertCommand(parent: Command): void {
  parent
    .command("insert")
    .description("Insert rows into a data table")
    .argument("<dataTableId>", "Data table ID")
    .requiredOption("-d, --data <json>", 'Row data as JSON array (e.g., \'[{"col1":"value"}]\')')
    .option("--return-type <type>", "Return type: count, id, or all", "count")
    .action(async (dataTableId: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent?.parent!);

      let data: Record<string, unknown>[];
      try {
        data = JSON.parse(options.data as string);
      } catch {
        console.error("Error: Invalid JSON for --data option");
        process.exit(1);
      }

      const result = await ctx.dataTableService.insertRows(dataTableId, {
        data,
        returnType: options.returnType as "count" | "id" | "all" | undefined,
      });

      console.log("Rows inserted successfully");
      formatJSON(result, true);
    });
}
