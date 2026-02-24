import path from "node:path";
import type { Command } from "commander";
import { Executor } from "../../apply/executor.ts";
import { report } from "../../apply/reporter.ts";
import { defaultApplyOptions } from "../../apply/types.ts";
import {
  getEffectiveAutoTags,
  getEffectiveProjectID,
  getEffectiveYamlEnabled,
  loadCLIConfig,
} from "../../config/claude-md.ts";
import { resolveContext } from "../root.ts";

export function registerApplyCommand(program: Command): void {
  program
    .command("apply")
    .description("Apply workflow definitions to n8n server")
    .option("-d, --dir <path>", "Path to definitions directory", "./definitions")
    .option("-p, --project <id>", "Target project ID for workflow transfer")
    .option("--ids <ids>", "Comma-separated workflow IDs to process")
    .option(
      "--from-git-changes <spec>",
      "Apply only files changed in Git diff (e.g., origin/main..HEAD)",
    )
    .option("--dry-run", "Preview changes without applying")
    .option("--force", "Override conflict detection and duplicate warnings")
    .option("--no-auto-tag", "Disable automatic tagging")
    .option("--yaml", "Enable YAML file processing")
    .option("--no-yaml", "Disable YAML processing")
    .option(
      "--warn-duplicates",
      "Warn when creating workflows with names that already exist remotely",
    )
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent!);

      const opts = defaultApplyOptions();
      opts.directory = options.dir as string;
      opts.dryRun = !!options.dryRun;
      opts.force = !!options.force;
      opts.noAutoTag = !!options.noAutoTag;
      opts.warnDuplicates = !!options.warnDuplicates;

      if (options.yaml === true) opts.yamlEnabled = true;
      if (options.yaml === false) opts.noYaml = true;

      if (options.ids) {
        opts.ids = (options.ids as string).split(",").map((s: string) => s.trim());
      }

      if (options.fromGitChanges) {
        opts.fromGitChanges = true;
        opts.gitDiffSpec = options.fromGitChanges as string;
      }

      // Validate mutually exclusive flags
      if (opts.yamlEnabled && opts.noYaml) {
        console.error("Error: --yaml and --no-yaml cannot be used together");
        process.exit(1);
      }
      if (opts.fromGitChanges && opts.ids.length > 0) {
        console.error("Error: --from-git-changes and --ids cannot be used together");
        process.exit(1);
      }

      // Read tag filter from environment variable
      const filterTagsEnv = process.env.APPLY_FILTER_BY_TAGS;
      if (filterTagsEnv) {
        opts.filterByTags = filterTagsEnv
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        if (opts.filterByTags.length > 0) {
          console.log(`Filtering by tags: ${opts.filterByTags.join(", ")} (AND)`);
        }
      }

      // Load CLI config from CLAUDE.md
      const cliConfig = loadCLIConfig();

      // Apply project ID with precedence: flag > env > CLAUDE.md
      opts.projectID = getEffectiveProjectID(options.project ?? "", cliConfig);

      // Apply auto tags from config
      if (!opts.noAutoTag) {
        opts.autoTags = getEffectiveAutoTags(cliConfig);
      }

      // Apply YAML settings
      opts.yamlEnabled = getEffectiveYamlEnabled(opts.yamlEnabled, opts.noYaml, cliConfig);

      // Create executor
      const executor = new Executor(ctx.workflowService, opts);
      executor.setTagService(ctx.tagService);

      // Display Git diff mode message if enabled
      if (opts.fromGitChanges) {
        console.log(`Detecting changes from: ${opts.gitDiffSpec}`);
      }

      // Set progress callback for non-dry-run operations
      if (!opts.dryRun) {
        executor.setProgressCallback((current, total, filename, operation) => {
          console.log(`[${current}/${total}] ${path.basename(filename)}: ${operation}`);
        });
      }

      // Run apply
      const result = await executor.execute();

      // Display "no changes" message for Git diff mode
      if (opts.fromGitChanges && result.operations.length === 0) {
        console.log(`No changes detected in ${opts.directory}`);
        return;
      }

      // Report results
      report(result);

      // Return appropriate exit code
      if (result.errorCount > 0) {
        process.exit(1);
      }
      if (result.conflictCount > 0 && opts.dryRun) {
        process.exit(2);
      }
      if (result.warningCount > 0 && !opts.force && !opts.dryRun) {
        process.exit(2);
      }
    });
}
