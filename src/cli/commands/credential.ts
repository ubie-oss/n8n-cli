import type { Command } from "commander";
import { registerCredentialCreateCommand } from "./credential-create.ts";
import { registerCredentialDeleteCommand } from "./credential-delete.ts";
import { registerCredentialGetCommand } from "./credential-get.ts";
import { registerCredentialListCommand } from "./credential-list.ts";
import { registerCredentialSchemaCommand } from "./credential-schema.ts";
import { registerCredentialTransferCommand } from "./credential-transfer.ts";
import { registerCredentialUpdateCommand } from "./credential-update.ts";

export function registerCredentialCommand(program: Command): void {
  const credential = program.command("credential").description("Manage n8n credentials");
  registerCredentialListCommand(credential);
  registerCredentialGetCommand(credential);
  registerCredentialCreateCommand(credential);
  registerCredentialUpdateCommand(credential);
  registerCredentialDeleteCommand(credential);
  registerCredentialSchemaCommand(credential);
  registerCredentialTransferCommand(credential);
}
