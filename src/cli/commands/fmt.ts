import fs, { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { Workflow } from "@/api/types.ts";
import { WORKFLOW_EXTENSIONS } from "@/common/extensions.ts";
import { hasAllTags, parseTagFilter } from "@/common/tags.ts";
import { loadYamlWorkflow } from "@/yaml/loader.ts";
import { formatWorkflowAsync } from "../../formatter/formatter.ts";
import { generateChangeReport } from "../../formatter/reporter.ts";

/** registerFmtCommand registers the fmt subcommand */
export function registerFmtCommand(program: Command): void {
  program
    .command("fmt")
    .description("Format workflow files by reorganizing node positions")
    .option("--dry-run", "Show changes without saving", false)
    .option("-d, --directory <dir>", "Directory to scan for workflow files")
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .argument("[files...]", "Workflow JSON files to format")
    .action(
      async (files: string[], opts: { dryRun: boolean; directory?: string; tags?: string }) => {
        const targetFiles = [...files];

        // If directory is specified, scan for workflow files
        if (opts.directory) {
          const dirFiles = scanWorkflowFiles(opts.directory);
          targetFiles.push(...dirFiles);
        }

        if (targetFiles.length === 0) {
          console.error("Error: no files specified. Use -d <directory> or provide file paths.");
          process.exit(1);
        }

        // Parse tag filter (CLI option takes precedence over environment variable)
        const tagsOption = opts.tags;
        const tagsEnv = process.env.CHECKS_FILTER_BY_TAGS;
        const filterByTags = parseTagFilter(tagsOption ?? tagsEnv);

        if (filterByTags.length > 0) {
          console.error(`Filtering by tags: ${filterByTags.join(", ")} (AND)`);
        }

        let hasErrors = false;

        for (const filePath of targetFiles) {
          // Filter by tags
          if (filterByTags.length > 0) {
            try {
              const workflow = await loadWorkflowForTagCheck(filePath);
              if (workflow && !hasAllTags(workflow.tags, filterByTags)) {
                continue; // Skip this workflow
              }
            } catch (e) {
              // Load error - emit warning and continue processing (formatter will handle the error)
              console.warn(
                `Warning: Failed to load workflow for tag check: ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }

          const result = await formatWorkflowAsync(filePath, {
            dryRun: opts.dryRun,
          });

          if (!result.success) {
            console.error(`Error formatting ${filePath}: ${result.error?.message}`);
            hasErrors = true;
            continue;
          }

          const report = generateChangeReport(filePath, result.changes);
          process.stdout.write(report);
        }

        if (hasErrors) {
          process.exit(1);
        }
      },
    );
}

/** scanWorkflowFiles recursively scans a directory for workflow files (.json, .yaml, .yml, .jsonnet) */
function scanWorkflowFiles(dir: string): string[] {
  const results: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip _subfiles directories (they contain external files, not workflows)
        if (entry === "_subfiles") continue;
        results.push(...scanWorkflowFiles(fullPath));
      } else {
        const ext = path.extname(entry).toLowerCase();
        if (WORKFLOW_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return results;
}

/**
 * Loads workflow metadata (tags) for filtering without full formatting.
 */
async function loadWorkflowForTagCheck(filePath: string): Promise<Workflow | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    return loadYamlWorkflow(filePath);
  }
  const rawJSON = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(rawJSON) as Workflow;
  } catch {
    return null;
  }
}
