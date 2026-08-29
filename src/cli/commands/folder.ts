import type { Command } from "commander";
import { registerFolderCreateCommand } from "./folder-create.ts";
import { registerFolderDeleteCommand } from "./folder-delete.ts";
import { registerFolderGetCommand } from "./folder-get.ts";
import { registerFolderListCommand } from "./folder-list.ts";
import { registerFolderMoveCommand } from "./folder-move.ts";

export function registerFolderCommand(program: Command): void {
  const folder = program
    .command("folder")
    .description("Manage n8n workflow folders (requires a folder-licensed n8n plan)");
  registerFolderListCommand(folder);
  registerFolderGetCommand(folder);
  registerFolderCreateCommand(folder);
  registerFolderMoveCommand(folder);
  registerFolderDeleteCommand(folder);
}
