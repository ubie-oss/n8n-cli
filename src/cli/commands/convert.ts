import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { isFoldersConfigFile } from "@/apply/folders.ts";
import { WORKFLOW_EXTENSIONS, WORKFLOW_EXTENSIONS_WITH_TS } from "@/common/extensions.ts";
import { hasAllTags, parseTagFilter } from "@/common/tags.ts";
import { getEffectiveExternalizeThreshold, loadCLIConfig } from "@/config/claude-md.ts";
import { convertWorkflowFile, type TargetFormat } from "@/convert/converter.ts";
import { parseWorkflowFile } from "@/importer/scanner.ts";

/** registerConvertCommand registers the convert subcommand. */
export function registerConvertCommand(program: Command): void {
  program
    .command("convert")
    .description("Convert workflow files between formats (JSON / YAML / TS)")
    .requiredOption("--format <format>", "Target format: json, yaml, ts")
    .option("-d, --directory <dir>", "Directory to scan for workflow files")
    .option("--ids <ids>", "Comma-separated workflow IDs to convert")
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .option("-t, --threshold <n>", "Minimum lines for code externalization (JSON→YAML)", "0")
    .option("--dry-run", "Preview conversions without writing files", false)
    .option("--keep", "Keep original files after conversion", false)
    .option("--ts", "Include .ts files when scanning a directory", false)
    .argument("[files...]", "Specific workflow files to convert")
    .action(
      async (
        files: string[],
        opts: {
          format: string;
          directory?: string;
          ids?: string;
          tags?: string;
          threshold: string;
          dryRun: boolean;
          keep: boolean;
          ts: boolean;
        },
      ) => {
        // Validate target format
        const targetFormat = opts.format as TargetFormat;
        if (targetFormat !== "json" && targetFormat !== "yaml" && targetFormat !== "ts") {
          console.error(`Error: unsupported format "${opts.format}". Use "json", "yaml" or "ts".`);
          process.exit(1);
        }

        // Load config for threshold
        const cliConfig = loadCLIConfig();
        const threshold = getEffectiveExternalizeThreshold(
          Number.parseInt(opts.threshold, 10) || 0,
          cliConfig,
        );

        // Collect target files
        const targetFiles = [...files];
        if (opts.directory) {
          // Scanning a directory for `.ts` is opt-in: a repository that keeps
          // workflows as `.ts` is full of TypeScript that is not a workflow.
          // Explicit file arguments are always honoured, whatever the extension.
          targetFiles.push(...scanWorkflowFiles(opts.directory, opts.ts));
        }

        if (targetFiles.length === 0) {
          console.error("Error: no files specified. Use -d <directory> or provide file paths.");
          process.exit(1);
        }

        // Parse --ids filter
        const idsFilter = opts.ids
          ? new Set(
              opts.ids
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          : null;

        // Parse --tags filter
        const filterByTags = parseTagFilter(opts.tags);

        if (filterByTags.length > 0) {
          console.error(`Filtering by tags: ${filterByTags.join(", ")} (AND)`);
        }

        let converted = 0;
        let skipped = 0;
        let errors = 0;

        for (const filePath of targetFiles) {
          // ID filtering
          if (idsFilter) {
            try {
              const wf = parseWorkflowFile(filePath);
              if (!wf.id || !idsFilter.has(wf.id)) {
                continue;
              }
            } catch {
              // Cannot parse — skip
              continue;
            }
          }

          // Tag filtering
          if (filterByTags.length > 0) {
            try {
              const wf = parseWorkflowFile(filePath);
              if (!hasAllTags(wf.tags, filterByTags)) {
                continue;
              }
            } catch {
              // Cannot parse — skip
              continue;
            }
          }

          const directory = opts.directory ?? path.dirname(filePath);

          const result = convertWorkflowFile(filePath, {
            targetFormat,
            directory,
            externalizeThreshold: threshold,
            dryRun: opts.dryRun,
            keepOriginal: opts.keep,
          });

          if (result.error) {
            console.error(`Error: ${filePath}: ${result.error.message}`);
            errors++;
            continue;
          }

          if (result.skipped) {
            console.error(`Skip: ${filePath}: ${result.skipReason}`);
            skipped++;
            continue;
          }

          const dryRunLabel = opts.dryRun ? " (dry-run)" : "";
          console.log(`Converted${dryRunLabel}: ${filePath} → ${result.outputPath}`);

          if (result.removedFiles.length > 0) {
            for (const removed of result.removedFiles) {
              console.log(`  Removed: ${removed}`);
            }
          }

          converted++;
        }

        console.log(`\nConverted: ${converted}, Skipped: ${skipped}, Errors: ${errors}`);

        if (errors > 0) {
          process.exit(1);
        }
      },
    );
}

/** Recursively scans a directory for workflow files (.json, .yaml, .yml). */
function scanWorkflowFiles(dir: string, includeTs = false): string[] {
  const results: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (entry.startsWith("_")) continue;
        results.push(...scanWorkflowFiles(fullPath, includeTs));
      } else {
        // `folders.yaml` is folder-as-code config, not a workflow to convert.
        if (isFoldersConfigFile(entry)) continue;
        const ext = path.extname(entry).toLowerCase();
        const allowed = includeTs ? WORKFLOW_EXTENSIONS_WITH_TS : WORKFLOW_EXTENSIONS;
        if (allowed.has(ext) && !entry.toLowerCase().endsWith(".d.ts")) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return results;
}
