import type { Command } from "commander";
import type { DataTableRow } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerDataTableRowsListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List rows in a data table")
    .argument("<dataTableId>", "Data table ID")
    .option("-l, --limit <n>", "Maximum number of rows to return per page")
    .option("--filter <json>", "Filter as JSON string")
    .option("--sort-by <field:dir>", "Sort by field and direction")
    .option("--search <text>", "Search text")
    .action(async (dataTableId: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent?.parent!);

      const limit = options.limit ? Number.parseInt(options.limit as string, 10) : undefined;
      const rows = await ctx.dataTableService.listAllRows(dataTableId);

      const result = limit && limit > 0 ? rows.slice(0, limit) : rows;
      outputRows(result, ctx.config.output);
    });
}

function outputRows(rows: DataTableRow[], format: string): void {
  if (format === "table") {
    console.log(`Found ${rows.length} row(s)\n`);

    if (rows.length === 0) return;

    // Dynamically generate headers from the first row's keys
    const headers = Object.keys(rows[0]!).map((k) => k.toUpperCase());
    const keys = Object.keys(rows[0]!);
    const tableRows = rows.map((r) =>
      keys.map((k) => {
        const v = r[k];
        if (v === null || v === undefined) return "-";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      }),
    );
    formatTable(headers, tableRows);
  } else {
    formatJSON(rows, true);
  }
}
