import type { Command } from "commander";
import { isForbiddenError } from "@/api/errors.ts";
import { folderPathOf, PERSONAL_PROJECT } from "@/api/folder-service.ts";
import type { Folder } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue, formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

/**
 * Registers the `folder` command group.
 *
 * Every subcommand takes the project explicitly rather than inferring one:
 * folders are project-scoped, the API's `personal` alias only means something
 * for a human's own project, and quietly acting on the wrong project is the one
 * failure mode a folder command must not have.
 */
export function registerFolderCommand(program: Command): void {
  const folder = program
    .command("folder")
    .description("Manage workflow folders within an n8n project (licensed feature)");

  registerList(folder);
  registerGet(folder);
  registerCreate(folder);
  registerUpdate(folder);
  registerDelete(folder);
}

/** Shared `--project` option text, so every subcommand documents it the same. */
const PROJECT_OPTION_DESC = `Project ID, or "${PERSONAL_PROJECT}" for your personal project`;

function registerList(parent: Command): void {
  parent
    .command("list")
    .description("List folders in a project")
    .option("-p, --project <id>", PROJECT_OPTION_DESC, PERSONAL_PROJECT)
    .option("--parent <folderId>", "Only list direct children of this folder")
    .option("--name <substring>", "Only list folders whose name contains this substring")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      await withFolderErrors(async () => {
        const folders = await ctx.folderService.listAllFolders(options.project as string, {
          ...(options.parent ? { parentFolderId: options.parent as string } : {}),
          ...(options.name ? { name: options.name as string } : {}),
        });
        outputFolders(folders, ctx.config.output);
      });
    });
}

function registerGet(parent: Command): void {
  parent
    .command("get <folderId>")
    .description("Get a folder by ID")
    .option("-p, --project <id>", PROJECT_OPTION_DESC, PERSONAL_PROJECT)
    .action(async (folderID: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      await withFolderErrors(async () => {
        const folder = await ctx.folderService.getFolder(options.project as string, folderID);
        outputFolder(folder, ctx.config.output);
      });
    });
}

function registerCreate(parent: Command): void {
  parent
    .command("create <name>")
    .description("Create a folder")
    .option("-p, --project <id>", PROJECT_OPTION_DESC, PERSONAL_PROJECT)
    .option("--parent <folderId>", "Create the folder inside this folder")
    .action(async (name: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      await withFolderErrors(async () => {
        const folder = await ctx.folderService.createFolder(options.project as string, {
          name,
          ...(options.parent ? { parentFolderId: options.parent as string } : {}),
        });
        console.log("Folder created successfully");
        outputFolder(folder, ctx.config.output);
      });
    });
}

function registerUpdate(parent: Command): void {
  parent
    .command("update <folderId>")
    .description("Rename a folder or move it under a different parent")
    .option("-p, --project <id>", PROJECT_OPTION_DESC, PERSONAL_PROJECT)
    .option("-n, --name <name>", "New folder name")
    .option("--parent <folderId>", "Move the folder inside this folder")
    .action(async (folderID: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      // The API rejects an empty patch, and a command that silently did nothing
      // would look like it had worked.
      if (options.name === undefined && options.parent === undefined) {
        console.error("Error: pass --name or --parent — there is nothing to update otherwise");
        process.exit(1);
      }

      await withFolderErrors(async () => {
        const folder = await ctx.folderService.updateFolder(options.project as string, folderID, {
          ...(options.name !== undefined ? { name: options.name as string } : {}),
          ...(options.parent !== undefined ? { parentFolderId: options.parent as string } : {}),
        });
        console.log("Folder updated successfully");
        outputFolder(folder, ctx.config.output);
      });
    });
}

function registerDelete(parent: Command): void {
  parent
    .command("delete <folderId>")
    .description("Delete a folder")
    .option("-p, --project <id>", PROJECT_OPTION_DESC, PERSONAL_PROJECT)
    .option(
      "--transfer-to <folderId>",
      "Move the folder's workflows and sub-folders here before deleting",
    )
    .action(async (folderID: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      await withFolderErrors(async () => {
        await ctx.folderService.deleteFolder(
          options.project as string,
          folderID,
          options.transferTo as string | undefined,
        );
        console.log(`Folder ${folderID} deleted successfully`);
      });
    });
}

/**
 * Runs a folder call, translating the licensed-feature 403 into an explanation.
 *
 * Without this the user sees a bare "Forbidden" and goes looking at their API
 * key, when the actual answer is that the instance does not have folders.
 */
async function withFolderErrors(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (isForbiddenError(err)) {
      console.error(
        [
          "Error: the n8n instance rejected the folders API (403).",
          "",
          "Folders are a licensed n8n feature. Check that the instance has it",
          "enabled, and that the API key's scopes cover the folder:* operations.",
        ].join("\n"),
      );
      process.exit(1);
    }
    throw err;
  }
}

function outputFolders(folders: Folder[], format: string): void {
  if (format === "table") {
    console.log(`Found ${folders.length} folder(s)\n`);
    if (folders.length === 0) return;

    const headers = ["ID", "PATH", "UPDATED"];
    const rows = folders.map((f) => [
      f.id,
      folderPathOf(f),
      f.updatedAt ? f.updatedAt.slice(0, 19).replace("T", " ") : "-",
    ]);
    formatTable(headers, rows);
  } else {
    formatJSON(folders, true);
  }
}

function outputFolder(folder: Folder, format: string): void {
  if (format === "table") {
    formatKeyValue({
      ID: folder.id,
      Name: folder.name,
      Path: folderPathOf(folder),
      Parent: folder.parentFolderId ?? folder.parentFolder?.id ?? "(root)",
      Created: folder.createdAt ? folder.createdAt.slice(0, 19).replace("T", " ") : "-",
      Updated: folder.updatedAt ? folder.updatedAt.slice(0, 19).replace("T", " ") : "-",
    });
  } else {
    formatJSON(folder, true);
  }
}
