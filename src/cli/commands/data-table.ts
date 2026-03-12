import type { Command } from "commander";
import { registerDataTableCreateCommand } from "./data-table-create.ts";
import { registerDataTableDeleteCommand } from "./data-table-delete.ts";
import { registerDataTableGetCommand } from "./data-table-get.ts";
import { registerDataTableListCommand } from "./data-table-list.ts";
import { registerDataTableRowsDeleteCommand } from "./data-table-rows-delete.ts";
import { registerDataTableRowsInsertCommand } from "./data-table-rows-insert.ts";
import { registerDataTableRowsListCommand } from "./data-table-rows-list.ts";
import { registerDataTableRowsUpdateCommand } from "./data-table-rows-update.ts";
import { registerDataTableRowsUpsertCommand } from "./data-table-rows-upsert.ts";
import { registerDataTableUpdateCommand } from "./data-table-update.ts";

export function registerDataTableCommand(program: Command): void {
  const dt = program.command("data-tables").description("Manage n8n data tables");

  // Table CRUD commands
  registerDataTableListCommand(dt);
  registerDataTableGetCommand(dt);
  registerDataTableCreateCommand(dt);
  registerDataTableUpdateCommand(dt);
  registerDataTableDeleteCommand(dt);

  // Rows subcommand group
  const rows = dt.command("rows").description("Manage data table rows");
  registerDataTableRowsListCommand(rows);
  registerDataTableRowsInsertCommand(rows);
  registerDataTableRowsUpdateCommand(rows);
  registerDataTableRowsUpsertCommand(rows);
  registerDataTableRowsDeleteCommand(rows);
}
