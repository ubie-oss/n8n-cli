import type { Command } from "commander";
import {
  getEffectiveExternalizeThreshold,
  getEffectiveTsEnabled,
  getEffectiveYamlEnabled,
  loadCLIConfig,
} from "../../config/claude-md.ts";
import { ImportExecutor } from "../../importer/executor.ts";
import { reportDryRun, reportProgress, reportSummary } from "../../importer/reporter.ts";
import { defaultImportOptions, type ImportOptions } from "../../importer/types.ts";
import { resolveContext } from "../root.ts";

export function registerImportCommand(parent: Command): void {
  parent
    .command("import")
    .description("Import workflows from n8n to local files")
    .option("--dry-run", "Preview changes without writing files", false)
    .option("-d, --dir <directory>", "Target directory for workflow files", "./definitions")
    .option("--ids <ids>", "Comma-separated workflow IDs to import (empty = all)")
    .option("--include-archived", "Include archived workflows", false)
    // Neither format flag carries a default value. With one, commander reports
    // `false` even when the flag was never passed, which is indistinguishable
    // from `--no-yaml` / `--no-ts` and makes the CLAUDE.md setting unreachable.
    .option("--yaml", "Output as YAML format with external files")
    .option("--no-yaml", "Force JSON format output")
    .option("--ts", "Output new workflows as .ts (@n8n/workflow-sdk format)")
    .option("--no-ts", "Do not write .ts output")
    .option("-t, --threshold <n>", "Minimum lines for code externalization", "0")
    .option("--cleanup-orphans", "Delete local files without matching remote workflow", false)
    .option("--cleanup-subfiles", "Delete orphan external files in _subfiles directories", false)
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent!);
      const cliConfig = loadCLIConfig();

      // The flags carry no default, so `undefined` means "not passed" and the
      // CLAUDE.md setting decides.
      const yamlFlag = options.yaml === true;
      const noYamlFlag = options.yaml === false;
      const tsFlag = options.ts === true;
      const noTsFlag = options.ts === false;

      // Unlike apply — which scans every enabled format — import writes one
      // format per new workflow, so asking for two is a mistake worth catching
      // rather than resolving by an invisible precedence rule.
      if (yamlFlag && tsFlag) {
        console.error("Error: --yaml and --ts cannot be used together");
        process.exit(1);
      }

      const importOpts: ImportOptions = {
        ...defaultImportOptions(),
        directory: options.dir as string,
        dryRun: options.dryRun as boolean,
        includeArchived: options.includeArchived as boolean,
        yamlEnabled: getEffectiveYamlEnabled(yamlFlag, noYamlFlag, cliConfig),
        tsEnabled: getEffectiveTsEnabled(tsFlag, noTsFlag, cliConfig),
        externalizeThreshold: getEffectiveExternalizeThreshold(
          Number.parseInt(options.threshold as string, 10) || 0,
          cliConfig,
        ),
        cleanupOrphans: options.cleanupOrphans as boolean,
        cleanupSubfiles: options.cleanupSubfiles as boolean,
        ids: options.ids
          ? (options.ids as string)
              .split(",")
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0)
          : [],
        filterByTags: options.tags
          ? (options.tags as string)
              .split(",")
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0)
          : [],
      };

      const executor = new ImportExecutor(ctx.workflowService, importOpts);
      executor.setProgressCallback(reportProgress);

      try {
        const result = await executor.execute();

        if (importOpts.dryRun) {
          reportDryRun(result);
        } else {
          reportSummary(result);
        }

        if (result.hasErrors()) {
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
