import type { Command } from "commander";
import type { Credential } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List all credentials")
    .option("-l, --limit <n>", "Maximum number of credentials to return per page")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      const limit = options.limit ? Number.parseInt(options.limit as string, 10) : undefined;
      const credentials = await ctx.credentialService.listAllCredentials();

      const result = limit && limit > 0 ? credentials.slice(0, limit) : credentials;
      outputCredentials(result, ctx.config.output);
    });
}

function outputCredentials(credentials: Credential[], format: string): void {
  if (format === "table") {
    console.log(`Found ${credentials.length} credential(s)\n`);

    if (credentials.length === 0) return;

    const headers = ["ID", "NAME", "TYPE", "CREATED", "UPDATED"];
    const rows = credentials.map((c) => [
      c.id ?? "-",
      c.name,
      c.type,
      c.createdAt ? c.createdAt.slice(0, 19).replace("T", " ") : "-",
      c.updatedAt ? c.updatedAt.slice(0, 19).replace("T", " ") : "-",
    ]);
    formatTable(headers, rows);
  } else {
    formatJSON(credentials, true);
  }
}
