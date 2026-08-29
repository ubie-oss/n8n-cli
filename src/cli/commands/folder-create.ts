import type { Command } from "commander";
import { splitFolderPath } from "@/api/folder-service.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerFolderCreateCommand(parent: Command): void {
  parent
    .command("create <name>")
    .description("Create a folder, optionally inside a parent folder")
    .option("-p, --project <id>", "Project ID (env: N8N_DEFAULT_PROJECT)")
    .option("--parent <folderId>", "Parent folder ID (omit to create at the project root)")
    .action(async (name, options, command) => {
      const ctx = resolveContext(command.parent!.parent!);
      const projectId = options.project || process.env.N8N_DEFAULT_PROJECT;
      if (!projectId) {
        console.error("Error: project is required (pass -p/--project or set N8N_DEFAULT_PROJECT)");
        process.exit(1);
      }
      if (splitFolderPath(name).length !== 1) {
        console.error('Error: folder name must be a single name without "/"');
        process.exit(1);
      }

      const folder = await ctx.folderService.createFolder(projectId, {
        name: name.trim(),
        ...(typeof options.parent === "string" ? { parentFolderId: options.parent } : {}),
      });
      console.log(`Created folder "${folder.name}" (${folder.id})`);
    });
}
