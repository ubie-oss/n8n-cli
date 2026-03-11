import type { Command } from "commander";
import type { Credential } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialCreateCommand(parent: Command): void {
  parent
    .command("create")
    .description("Create a new credential")
    .requiredOption("-n, --name <name>", "Credential name")
    .requiredOption("-t, --type <type>", "Credential type (e.g., slackApi, googleSheetsOAuth2Api)")
    .requiredOption("-d, --data <json>", "Credential data as JSON string")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(options.data as string);
      } catch {
        console.error("Error: Invalid JSON for --data option");
        process.exit(1);
      }

      const credential = await ctx.credentialService.createCredential({
        name: options.name as string,
        type: options.type as string,
        data,
      });

      console.log("Credential created successfully");
      outputCredential(credential, ctx.config.output);
    });
}

function outputCredential(credential: Credential, format: string): void {
  if (format === "table") {
    formatKeyValue({
      ID: credential.id ?? "-",
      Name: credential.name,
      Type: credential.type,
      Created: credential.createdAt ? credential.createdAt.slice(0, 19).replace("T", " ") : "-",
      Updated: credential.updatedAt ? credential.updatedAt.slice(0, 19).replace("T", " ") : "-",
    });
  } else {
    formatJSON(credential, true);
  }
}
