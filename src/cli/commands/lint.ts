import type { Command } from "commander";
import { hasAllTags, parseTagFilter } from "@/common/tags.ts";
import { loadLintConfig } from "@/lint/config.ts";
import { formatJSON } from "@/lint/output/json.ts";
import type { LintResult } from "@/lint/output/result.ts";
import { hasErrors } from "@/lint/output/result.ts";
import { formatText } from "@/lint/output/text.ts";
import { registerDefaultRules } from "@/lint/rules/index.ts";
import { loadFileForLint, scanFiles } from "@/lint/scanner.ts";

/** Registers the lint command on the program */
export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Lint workflow definition files")
    .option("-d, --dir <directory>", "Directory to scan for workflow files")
    .option("-f, --file <files...>", "Specific files to lint (can be repeated)")
    .option("-c, --config <path>", "Path to .n8nlintrc.json config file")
    .option("--disable-rule <rules...>", "Disable specific rules (can be repeated)")
    .option("--list-rules", "List all available rules and exit")
    .option("-o, --output <format>", "Output format: text, json", "text")
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .action(async (opts) => {
      const registry = registerDefaultRules();

      // List rules mode
      if (opts.listRules) {
        const rules = registry.all();
        for (const rule of rules) {
          console.log(`  ${rule.name} (${rule.defaultSeverity}): ${rule.description}`);
        }
        return;
      }

      // Load config
      const config = opts.config ? loadLintConfig(opts.config) : loadLintConfig();

      // Get enabled rules
      const enabledRules = registry.enabledRulesWithConfig(config, opts.disableRule);

      // Parse tag filter (CLI option takes precedence over environment variable)
      const tagsOption = opts.tags as string | undefined;
      const tagsEnv = process.env.CHECKS_FILTER_BY_TAGS;
      const filterByTags = parseTagFilter(tagsOption ?? tagsEnv);

      if (filterByTags.length > 0) {
        // Use stderr to avoid corrupting JSON output
        if (opts.output !== "json") {
          console.error(`Filtering by tags: ${filterByTags.join(", ")} (AND)`);
        }
      }

      // Collect files to lint
      let files: string[] = [];
      if (opts.file) {
        files = opts.file;
      } else if (opts.dir) {
        files = scanFiles(opts.dir);
      } else {
        console.error("Error: specify --dir or --file to indicate files to lint");
        process.exit(1);
      }

      if (files.length === 0) {
        console.error("No files found to lint");
        process.exit(1);
      }

      // Run linting
      const result: LintResult = {
        violations: [],
        filesChecked: 0,
        filesFailed: 0,
      };

      const failedFiles = new Set<string>();

      for (const filePath of files) {
        result.filesChecked++;

        const outcome = await loadFileForLint(filePath, filterByTags);
        if (outcome.status === "skipped") {
          result.violations.push({
            file: filePath,
            rule: "file-read",
            severity: "warning",
            message: outcome.message,
          });
          result.filesChecked--;
          continue;
        }
        if (outcome.status === "error") {
          result.violations.push({
            file: filePath,
            rule: "file-read",
            severity: "error",
            message: outcome.message,
          });
          failedFiles.add(filePath);
          continue;
        }

        const { rawJSON, workflow } = outcome.data;

        // Filter by tags
        if (workflow && filterByTags.length > 0) {
          if (!hasAllTags(workflow.tags, filterByTags)) {
            result.filesChecked--; // Don't count filtered files
            continue;
          }
        }

        // Run each enabled rule
        for (const { rule, severity } of enabledRules) {
          const violations = rule.check(workflow, rawJSON);
          for (const v of violations) {
            result.violations.push({
              ...v,
              file: v.file ?? filePath,
              severity,
            });
            failedFiles.add(filePath);
          }
        }
      }

      result.filesFailed = failedFiles.size;

      // Output results
      const outputFormat = opts.output ?? "text";
      if (outputFormat === "json") {
        console.log(formatJSON(result));
      } else {
        console.log(formatText(result));
      }

      // Exit with error code if there are errors
      if (hasErrors(result)) {
        process.exit(1);
      }
    });
}
