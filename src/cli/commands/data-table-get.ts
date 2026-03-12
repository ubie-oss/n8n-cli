import type { Command } from "commander";
import type { DataTable } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue, formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableGetCommand(parent: Command): void {
  parent
    .command("get")
    .description("Get a data table by ID")
    .argument("<id>", "Data table ID")
    .action(async (id: string, _options, command) => {
      const ctx = resolveContext(command.parent?.parent!);
      const table = await ctx.dataTableService.getDataTable(id);

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

    if (table.columns.length > 0) {
      console.log(`\nColumns (${table.columns.length}):`);
      const headers = ["ID", "NAME", "TYPE", "INDEX"];
      const rows = table.columns.map((c) => [
        c.id ?? "-",
        c.name,
        c.type,
        c.index !== undefined ? String(c.index) : "-",
      ]);
      formatTable(headers, rows);
    }
  } else {
    formatJSON(table, true);
  }
}
