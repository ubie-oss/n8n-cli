import { createInterface } from "node:readline";
import type { Command } from "commander";
import { isAuthError, isNotFoundError } from "@/api/errors.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerCredentialDeleteCommand(parent: Command): void {
  parent
    .command("delete")
    .description("Delete one or more credentials")
    .argument("<ids...>", "One or more credential IDs to delete")
    .option("--force", "Skip confirmation prompt")
    .action(async (ids: string[], options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      if (!options.force) {
        const lines: string[] = [];
        for (const id of ids) {
          try {
            const credential = await ctx.credentialService.getCredential(id);
            lines.push(`  - ${credential.name} (${id})`);
          } catch (err) {
            if (isNotFoundError(err)) {
              console.error(`Error: credential not found: ${id}`);
              process.exit(1);
            }
            if (isAuthError(err)) {
              throw err;
            }
            lines.push(`  - ${id}`);
          }
        }

        console.log(
          `The following ${ids.length} credential(s) will be deleted:\n${lines.join("\n")}`,
        );

        const confirmed = await confirmDelete("these credentials");
        if (!confirmed) {
          console.log("Deletion cancelled");
          return;
        }
      }

      let succeeded = 0;
      let failed = 0;

      for (const id of ids) {
        try {
          await ctx.credentialService.deleteCredential(id);
          console.log(`Deleted: ${id}`);
          succeeded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Error deleting ${id}: ${msg}`);
          failed++;
        }
      }

      console.log(`\nSummary: ${succeeded} succeeded, ${failed} failed (of ${ids.length} total)`);

      if (failed > 0) {
        process.exit(1);
      }
    });
}

function confirmDelete(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`Are you sure you want to delete ${name}? [y/N]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}
