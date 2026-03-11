import type { Command } from "commander";
import type { CredentialSchema } from "@/api/types.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialSchemaCommand(parent: Command): void {
  parent
    .command("schema")
    .description("Get the schema for a credential type")
    .argument("<typeName>", "Credential type name (e.g., slackApi, googleSheetsOAuth2Api)")
    .action(async (typeName: string, _options, command) => {
      const ctx = resolveContext(command.parent?.parent!);
      const schema = await ctx.credentialService.getCredentialSchema(typeName);

      outputSchema(schema, typeName, ctx.config.output);
    });
}

function outputSchema(schema: CredentialSchema, typeName: string, format: string): void {
  if (format === "table") {
    console.log(`Schema for credential type: ${typeName}\n`);

    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      console.log("No properties defined");
      return;
    }

    const headers = ["PROPERTY", "TYPE", "REQUIRED", "DEFAULT"];
    const required = new Set(schema.required ?? []);
    const rows = Object.entries(schema.properties).map(([name, prop]) => [
      name,
      prop.type ?? "-",
      required.has(name) ? "Yes" : "No",
      prop.default !== undefined ? String(prop.default) : "-",
    ]);
    formatTable(headers, rows);
  } else {
    formatJSON(schema, true);
  }
}
