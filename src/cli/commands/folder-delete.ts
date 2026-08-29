import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";

export function registerFolderDeleteCommand(parent: Command): void {
  parent
    .command("delete <folderId>")
    .description(
      "Delete a folder (its workflows and subfolders move to the project root unless --transfer-to is given)",
    )
    .option("-p, --project <id>", "Project ID (env: N8N_DEFAULT_PROJECT)")
    .option(
      "--transfer-to <folderId>",
      "Move the folder's contents to this folder instead of the project root",
    )
    .option("-f, --force", "Skip the confirmation prompt")
    .action(async (folderId, options, command) => {
      const ctx = resolveContext(command.parent!.parent!);
      const projectId = options.project || process.env.N8N_DEFAULT_PROJECT;
      if (!projectId) {
        console.error("Error: project is required (pass -p/--project or set N8N_DEFAULT_PROJECT)");
        process.exit(1);
      }

      if (!options.force) {
        const confirmed = await confirm(
          `Delete folder ${folderId}? Its contents will move to ${
            typeof options.transferTo === "string" ? options.transferTo : "the project root"
          }. Continue? [y/N] `,
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }

      await ctx.folderService.deleteFolder(
        projectId,
        folderId,
        typeof options.transferTo === "string" ? options.transferTo : undefined,
      );
      console.log(`Deleted folder ${folderId}`);
    });
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(prompt);
  for await (const chunk of process.stdin) {
    const answer = String(chunk).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}
