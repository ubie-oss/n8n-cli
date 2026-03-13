import type { Command } from "commander";
import { parseTagFilter } from "@/common/tags.ts";
import { hasAllTags } from "@/common/tags.ts";
import { loadFileForLint, scanFiles } from "@/lint/scanner.ts";
import { analyzeWorkflow } from "@/trace/analyzer.ts";
import { formatTraceJSON } from "@/trace/output/json.ts";
import { formatTraceText } from "@/trace/output/text.ts";

/** Registers the trace command on the program */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace")
    .description("Trace item cardinality flow through workflow nodes")
    .option("-d, --dir <directory>", "Directory to scan for workflow files")
    .option("-f, --file <files...>", "Specific files to trace (can be repeated)")
    .option("--json", "Output as JSON")
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .action(async (opts) => {
      const filterByTags = parseTagFilter(opts.tags as string | undefined);

      // Collect files
      let files: string[] = [];
      if (opts.file) {
        files = opts.file;
      } else if (opts.dir) {
        files = scanFiles(opts.dir);
      } else {
        console.error("Error: specify --dir or --file to indicate files to trace");
        process.exit(1);
      }

      if (files.length === 0) {
        console.error("No files found to trace");
        process.exit(1);
      }

      const results = [];

      for (const filePath of files) {
        const outcome = await loadFileForLint(filePath, filterByTags);
        if (outcome.status === "skipped") {
          if (!opts.json) {
            console.error(`Skipped: ${filePath} (${outcome.message})`);
          }
          continue;
        }
        if (outcome.status === "error") {
          console.error(`Error loading ${filePath}: ${outcome.message}`);
          continue;
        }

        const { workflow } = outcome.data;
        if (!workflow) {
          console.error(`Error: could not parse workflow from ${filePath}`);
          continue;
        }

        // Filter by tags
        if (filterByTags.length > 0 && !hasAllTags(workflow.tags, filterByTags)) {
          continue;
        }

        const result = analyzeWorkflow(workflow, filePath);
        results.push(result);
      }

      if (results.length === 0) {
        console.error("No workflows to trace");
        process.exit(1);
      }

      if (opts.json) {
        if (results.length === 1) {
          console.log(formatTraceJSON(results[0]!));
        } else {
          console.log(JSON.stringify(results, null, 2));
        }
      } else {
        for (let i = 0; i < results.length; i++) {
          if (i > 0) console.log();
          formatTraceText(results[i]!);
        }
      }
    });
}
