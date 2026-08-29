import type { Command } from "commander";
import { buildFolderIndex, folderParentId } from "@/api/folder-service.ts";
import type { Folder } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerFolderListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List folders in a project")
    .option("-p, --project <id>", "Project ID (env: N8N_DEFAULT_PROJECT)")
    .option("--parent <folderId>", "Only folders directly under this folder")
    .option("--root", "Only folders directly at the project root")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent!.parent!);
      const projectId = options.project || process.env.N8N_DEFAULT_PROJECT;
      if (!projectId) {
        console.error("Error: project is required (pass -p/--project or set N8N_DEFAULT_PROJECT)");
        process.exit(1);
      }

      let folders = await ctx.folderService.listAllFolders(projectId);
      if (options.root) {
        folders = folders.filter((f) => folderParentId(f) === null);
      } else if (typeof options.parent === "string") {
        folders = folders.filter((f) => folderParentId(f) === options.parent);
      }

      const paths = buildFolderIndex(folders).pathById;
      outputFolders(folders, ctx.config.output, paths);
    });
}

export function outputFolders(
  folders: Folder[],
  format: string,
  paths?: Map<string, string>,
): void {
  if (format === "table") {
    console.log(`Found ${folders.length} folder(s)\n`);
    if (folders.length === 0) return;

    const headers = ["ID", "NAME", "PATH", "PARENT"];
    const rows = folders.map((f) => [
      f.id,
      f.name,
      paths?.get(f.id) ?? "-",
      folderParentId(f) ?? "-",
    ]);
    formatTable(headers, rows);
  } else {
    formatJSON(folders, true);
  }
}
