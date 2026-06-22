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
import { LintConfigLoadError } from "../../lint/write-check.ts";
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
      "--dangerously-apply-all",
      "Apply ALL workflows in the directory, overwriting remote state (required when no scope filter is specified)",
    )
    .option(
      "--allow-duplicates",
      "Skip the upstream duplicate-name check (the check is on by default; use --force to push through warnings without disabling the check)",
    )
    .option(
      "--no-lint",
      "Skip the pre-write lint check (the check is on by default; --force does NOT bypass it because lint failures are policy, not merge conflicts)",
    )
    .option(
      "--lint-config <path>",
      "Path to .n8nlintrc.json for the pre-write lint check (auto-discovered if omitted)",
    )
    .option(
      "--lint-disable-rule <rules>",
      "Comma-separated rule names to disable during the pre-write lint check",
    )
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent!);

      const opts = defaultApplyOptions();
      opts.directory = options.dir as string;
      opts.all = !!options.dangerouslyApplyAll;
      opts.dryRun = !!options.dryRun;
      opts.force = !!options.force;
      opts.noAutoTag = !!options.noAutoTag;
      opts.allowDuplicates = !!options.allowDuplicates;
      // commander's `--no-lint` flips `options.lint` to false. When the flag is
      // not passed, `options.lint` is undefined and the check stays ON.
      opts.noLint = options.lint === false;
      if (typeof options.lintConfig === "string") {
        opts.lintConfigPath = options.lintConfig;
      }
      if (typeof options.lintDisableRule === "string") {
        opts.lintDisableRules = (options.lintDisableRule as string)
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r.length > 0);
      }

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

      // Require explicit scope: --ids, --from-git-changes, or --dangerously-apply-all
      const hasScope = opts.ids.length > 0 || opts.fromGitChanges || opts.filterByTags.length > 0;
      if (!hasScope && !opts.all) {
        console.error(
          [
            "Error: No scope specified — refusing to apply all workflows.",
            "",
            "You must specify which workflows to apply:",
            "  --ids <id1>,<id2>              Apply specific workflows by ID",
            "  --from-git-changes <spec>      Apply only files changed in Git diff",
            "",
            "Applying without a scope filter is not allowed by default.",
            "See --help for more options.",
          ].join("\n"),
        );
        process.exit(1);
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

      // Create executor. The constructor may throw `LintConfigLoadError` when
      // `.n8nlintrc.json` is malformed; surface it with a friendly message
      // instead of a raw SyntaxError stack so users know the fix is in the
      // config file (or to pass --no-lint as a temporary bypass).
      let executor: Executor;
      try {
        executor = new Executor(ctx.workflowService, opts);
      } catch (err) {
        if (err instanceof LintConfigLoadError) {
          console.error(`Error: ${err.message}`);
          console.error("Fix the config file, or pass --no-lint to bypass the pre-write check.");
          process.exit(1);
        }
        throw err;
      }
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
