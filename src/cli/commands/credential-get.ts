import type { Command } from "commander";
import type { Credential } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialGetCommand(parent: Command): void {
  parent
    .command("get")
    .description("Get a credential by ID")
    .argument("<id>", "Credential ID")
    .action(async (id: string, _options, command) => {
      const ctx = resolveContext(command.parent?.parent!);
      const credential = await ctx.credentialService.getCredential(id);

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
