import type { Command } from "commander";
import type { Credential, CredentialInput } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialUpdateCommand(parent: Command): void {
  parent
    .command("update")
    .description("Update an existing credential")
    .argument("<id>", "Credential ID")
    .option("-n, --name <name>", "New credential name")
    .option("-t, --type <type>", "New credential type")
    .option("-d, --data <json>", "New credential data as JSON string")
    .action(async (id: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      const input: Partial<CredentialInput> = {};

      if (options.name) {
        input.name = options.name as string;
      }
      if (options.type) {
        input.type = options.type as string;
      }
      if (options.data) {
        try {
          input.data = JSON.parse(options.data as string);
        } catch {
          console.error("Error: Invalid JSON for --data option");
          process.exit(1);
        }
      }

      if (Object.keys(input).length === 0) {
        console.error("Error: At least one of --name, --type, or --data must be provided");
        process.exit(1);
      }

      const credential = await ctx.credentialService.updateCredential(id, input);

      console.log("Credential updated successfully");
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
