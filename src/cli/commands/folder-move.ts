import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";

export function registerFolderMoveCommand(parent: Command): void {
  parent
    .command("move <folderId>")
    .description("Move a folder under a new parent (or to the project root), and/or rename it")
    .option("-p, --project <id>", "Project ID (env: N8N_DEFAULT_PROJECT)")
    .option("--parent <folderId>", "New parent folder ID")
    .option("--root", "Move the folder to the project root")
    .option("--rename <name>", "Rename the folder")
    .action(async (folderId, options, command) => {
      const ctx = resolveContext(command.parent!.parent!);
      const projectId = options.project || process.env.N8N_DEFAULT_PROJECT;
      if (!projectId) {
        console.error("Error: project is required (pass -p/--project or set N8N_DEFAULT_PROJECT)");
        process.exit(1);
      }
      if (options.root && options.parent) {
        console.error("Error: --root and --parent cannot be used together");
        process.exit(1);
      }
      if (!options.root && !options.parent && !options.rename) {
        console.error("Error: nothing to do — pass --parent, --root, or --rename");
        process.exit(1);
      }

      const folder = await ctx.folderService.updateFolder(projectId, folderId, {
        ...(options.root ? { parentFolderId: null } : {}),
        ...(typeof options.parent === "string" ? { parentFolderId: options.parent } : {}),
        ...(typeof options.rename === "string" ? { name: options.rename } : {}),
      });
      console.log(
        `Updated folder "${folder.name}" (${folder.id}) — parent: ${
          folder.parentFolderId ?? folder.parentFolder?.id ?? "project root"
        }`,
      );
    });
}
