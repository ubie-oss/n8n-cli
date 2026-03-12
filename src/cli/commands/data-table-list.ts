import type { Command } from "commander";
import type { DataTable } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List all data tables")
    .option("-l, --limit <n>", "Maximum number of data tables to return per page")
    .option("--filter <json>", "Filter as JSON string")
    .option("--sort-by <field:dir>", "Sort by field and direction (e.g., name:asc)")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      const limit = options.limit ? Number.parseInt(options.limit as string, 10) : undefined;
      const tables = await ctx.dataTableService.listAllDataTables();

      const result = limit && limit > 0 ? tables.slice(0, limit) : tables;
      outputDataTables(result, ctx.config.output);
    });
}

function outputDataTables(tables: DataTable[], format: string): void {
  if (format === "table") {
    console.log(`Found ${tables.length} data table(s)\n`);

    if (tables.length === 0) return;

    const headers = ["ID", "NAME", "COLUMNS", "PROJECT", "CREATED", "UPDATED"];
    const rows = tables.map((t) => [
      t.id,
      t.name,
      String(t.columns.length),
      t.projectId ?? "-",
      t.createdAt ? t.createdAt.slice(0, 19).replace("T", " ") : "-",
      t.updatedAt ? t.updatedAt.slice(0, 19).replace("T", " ") : "-",
    ]);
    formatTable(headers, rows);
  } else {
    formatJSON(tables, true);
  }
}
