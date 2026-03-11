import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialTransferCommand(parent: Command): void {
  parent
    .command("transfer")
    .description("Transfer a credential to a different project")
    .argument("<id>", "Credential ID")
    .requiredOption("-p, --project <projectId>", "Destination project ID")
    .action(async (id: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      await ctx.credentialService.transferCredential(id, {
        destinationProjectId: options.project as string,
      });

      console.log(`Credential ${id} transferred successfully to project ${options.project}`);
    });
}
