import type { Command } from "commander";
import type { DataTable } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableUpdateCommand(parent: Command): void {
  parent
    .command("update")
    .description("Update an existing data table")
    .argument("<id>", "Data table ID")
    .requiredOption("-n, --name <name>", "New data table name")
    .action(async (id: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);
      const table = await ctx.dataTableService.updateDataTable(id, {
        name: options.name as string,
      });

      console.log("Data table updated successfully");
      outputDataTable(table, ctx.config.output);
    });
}

function outputDataTable(table: DataTable, format: string): void {
  if (format === "table") {
    formatKeyValue({
      ID: table.id,
      Name: table.name,
      Project: table.projectId ?? "-",
      Created: table.createdAt ? table.createdAt.slice(0, 19).replace("T", " ") : "-",
      Updated: table.updatedAt ? table.updatedAt.slice(0, 19).replace("T", " ") : "-",
    });
  } else {
    formatJSON(table, true);
  }
}
