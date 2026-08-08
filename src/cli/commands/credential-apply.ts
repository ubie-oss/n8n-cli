import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";
import { CredentialApplyExecutor } from "@/credentials/executor.ts";
import { reportCredentialApply } from "@/credentials/reporter.ts";
import { defaultCredentialApplyOptions } from "@/credentials/types.ts";
import { defaultSecretResolvers } from "@/secrets/registry.ts";

export function registerCredentialApplyCommand(parent: Command): void {
  parent
    .command("apply")
    .description(
      "Apply local credential definitions to the n8n server, resolving secret references",
    )
    .option("-d, --dir <path>", "Path to credential definitions directory", "./credentials")
    .option("--ids <ids>", "Comma-separated credential IDs or file basenames to apply")
    .option(
      "--dry-run",
      "Report what would be written, and which secret references would be read, without doing either",
    )
    .option(
      "--force",
      "Create a credential even when one with the same name already exists upstream",
    )
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      const opts = defaultCredentialApplyOptions();
      opts.directory = options.dir as string;
      opts.dryRun = !!options.dryRun;
      opts.force = !!options.force;
      if (options.ids) {
        opts.ids = (options.ids as string)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }

      const executor = new CredentialApplyExecutor(
        ctx.credentialService,
        defaultSecretResolvers(),
        opts,
      );
      const result = await executor.execute();
      reportCredentialApply(result);

      if (result.errorCount > 0) {
        process.exit(1);
      }
      // Warnings here are name collisions that were pushed through with
      // --force. Exit 2 matches how `apply` reports "it worked, but look at
      // this" so the two commands behave the same way in a script.
      if (result.warningCount > 0 && !opts.dryRun) {
        process.exit(2);
      }
    });
}
