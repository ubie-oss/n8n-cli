import type { Command } from "commander";
import type { DataTable, DataTableColumn } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableCreateCommand(parent: Command): void {
  parent
    .command("create")
    .description("Create a new data table")
    .requiredOption("-n, --name <name>", "Data table name")
    .requiredOption(
      "-c, --columns <json>",
      'Columns as JSON array (e.g., \'[{"name":"col1","type":"string"}]\')',
    )
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      let columns: DataTableColumn[];
      try {
        columns = JSON.parse(options.columns as string);
      } catch {
        console.error("Error: Invalid JSON for --columns option");
        process.exit(1);
      }

      const table = await ctx.dataTableService.createDataTable({
        name: options.name as string,
        columns,
      });

      console.log("Data table created successfully");
      outputDataTable(table, ctx.config.output);
    });
}

function outputDataTable(table: DataTable, format: string): void {
  if (format === "table") {
    formatKeyValue({
      ID: table.id,
      Name: table.name,
      Columns: String(table.columns.length),
      Project: table.projectId ?? "-",
      Created: table.createdAt ? table.createdAt.slice(0, 19).replace("T", " ") : "-",
      Updated: table.updatedAt ? table.updatedAt.slice(0, 19).replace("T", " ") : "-",
    });
  } else {
    formatJSON(table, true);
  }
}
