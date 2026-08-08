import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";
import { importCredentials } from "@/credentials/importer.ts";
import { reportCredentialImport } from "@/credentials/reporter.ts";

export function registerCredentialImportCommand(parent: Command): void {
  parent
    .command("import")
    .description(
      "Scaffold local credential definition files from the server (values are never included)",
    )
    .option("-d, --dir <path>", "Path to credential definitions directory", "./credentials")
    .option("--ids <ids>", "Comma-separated credential IDs to import")
    .option("--dry-run", "Report which files would be written without writing them")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      const ids = options.ids
        ? (options.ids as string)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];

      const result = await importCredentials(ctx.credentialService, {
        directory: options.dir as string,
        dryRun: !!options.dryRun,
        ids,
      });

      reportCredentialImport(result);
    });
}
