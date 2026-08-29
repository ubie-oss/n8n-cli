import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";

export function registerFolderGetCommand(parent: Command): void {
  parent
    .command("get <folderId>")
    .description("Get a folder by ID")
    .option("-p, --project <id>", "Project ID (env: N8N_DEFAULT_PROJECT)")
    .action(async (folderId, options, command) => {
      const ctx = resolveContext(command.parent!.parent!);
      const projectId = options.project || process.env.N8N_DEFAULT_PROJECT;
      if (!projectId) {
        console.error("Error: project is required (pass -p/--project or set N8N_DEFAULT_PROJECT)");
        process.exit(1);
      }

      const folder = await ctx.folderService.getFolder(projectId, folderId);
      if (ctx.config.output === "table") {
        console.log(`ID:     ${folder.id}`);
        console.log(`Name:   ${folder.name}`);
        console.log(
          `Parent: ${folder.parentFolderId ?? folder.parentFolder?.id ?? "(project root)"}`,
        );
      } else {
        console.log(JSON.stringify(folder, null, 2));
      }
    });
}
