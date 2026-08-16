import type { Command } from "commander";
import { resolveContext } from "@/cli/root.ts";
import { workflowProjectId } from "@/common/project-id.ts";
import { hasAllTags, parseTagFilter } from "@/common/tags.ts";
import { findConfigFile, loadLintConfig } from "@/lint/config.ts";
import { lintWorkflow } from "@/lint/engine.ts";
import { formatJSON } from "@/lint/output/json.ts";
import type { LintResult } from "@/lint/output/result.ts";
import { hasErrors } from "@/lint/output/result.ts";
import { formatText } from "@/lint/output/text.ts";
import type { RuleRegistry } from "@/lint/registry.ts";
import { registerDefaultRules } from "@/lint/rules/index.ts";
import { loadFileForLint, scanFiles } from "@/lint/scanner.ts";

/** Registers the lint command on the program */
export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Lint workflow definition files")
    .option("-d, --dir <directory>", "Directory to scan for workflow files")
    .option("-f, --file <files...>", "Specific files to lint (can be repeated)")
    .option(
      "--remote",
      "Fetch workflows from n8n API instead of local files (requires N8N_API_URL and N8N_API_KEY)",
    )
    .option("--active-only", "Only lint active workflows (requires --remote)")
    .option("--ui-url <url>", "n8n UI base URL for workflow links (env: N8N_UI_URL)")
    .option("-c, --config <path>", "Path to .n8nlintrc.json config file")
    .option("--disable-rule <rules...>", "Disable specific rules (can be repeated)")
    .option("--list-rules", "List all available rules and exit")
    .option("-o, --output <format>", "Output format: text, json", "text")
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .option("--project <id>", "Project ID context for local workflow files")
    .action(async (opts, command) => {
      const registry = registerDefaultRules();

      // List rules mode
      if (opts.listRules) {
        const rules = registry.all();
        for (const rule of rules) {
          console.log(`  ${rule.name} (${rule.defaultSeverity}): ${rule.description}`);
        }
        return;
      }

      // Load config (auto-discover from CWD when -c is not specified)
      let resolvedConfigPath: string | undefined = opts.config;
      if (!resolvedConfigPath) {
        resolvedConfigPath = findConfigFile(process.cwd());
        if (resolvedConfigPath && opts.output !== "json") {
          console.error(`Using config: ${resolvedConfigPath}`);
        }
      }
      const config = loadLintConfig(resolvedConfigPath);

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

      if (opts.remote) {
        // Remote mode: fetch workflows from n8n API
        if (opts.dir || opts.file) {
          console.error("Error: --remote cannot be used with --dir or --file");
          process.exit(1);
        }
        if (opts.project) {
          console.error(
            "Error: --project cannot be used with --remote; remote ownership is detected per workflow",
          );
          process.exit(1);
        }

        const ctx = resolveContext(command.parent!);
        const workflows = await ctx.workflowService.listAllWorkflows({
          active: opts.activeOnly ? true : undefined,
          tags: filterByTags.length > 0 ? filterByTags : undefined,
        });

        const uiURL = opts.uiUrl ?? process.env.N8N_UI_URL ?? deriveUIURL(ctx.config.apiURL);

        await lintRemote(workflows, registry, config, opts.disableRule, uiURL, opts);
      } else {
        // Local mode: read files from filesystem
        await lintLocal(registry, config, opts.disableRule, filterByTags, opts);
      }
    });
}

/**
 * Derive the UI URL from the API URL by removing common API-only subdomains.
 * e.g. "https://n8n-direct.ubie.dev" → "https://n8n.ubie.dev"
 */
function deriveUIURL(apiURL: string): string {
  return apiURL.replace("n8n-direct.", "n8n.");
}

/** Display name for a remote workflow used in violation output. */
function workflowDisplayName(name: string, id: string | undefined): string {
  return id ? `${name} (${id})` : name;
}

/** Build the n8n UI URL for a workflow. */
function workflowURL(baseURL: string, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const base = baseURL.replace(/\/+$/, "");
  return `${base}/workflow/${id}`;
}

/** Lint workflows fetched from the n8n API. */
async function lintRemote(
  workflows: import("@/api/types.ts").Workflow[],
  registry: RuleRegistry,
  config: ReturnType<typeof loadLintConfig>,
  disabledRules: string[] | undefined,
  uiURL: string,
  opts: { output?: string },
): Promise<void> {
  const result: LintResult = {
    violations: [],
    filesChecked: 0,
    filesFailed: 0,
  };

  const failedWorkflows = new Set<string>();
  const lintContext = {
    workflows,
    workflowsById: new Map(
      workflows.flatMap((workflow) => (workflow.id ? [[workflow.id, workflow]] : [])),
    ),
  };

  for (const workflow of workflows) {
    result.filesChecked++;
    const displayName = workflowDisplayName(workflow.name, workflow.id);
    const rawJSON = JSON.stringify(workflow);
    const url = workflowURL(uiURL, workflow.id);

    const rules = registry.enabledRulesWithConfig(
      config,
      disabledRules,
      workflowProjectId(workflow),
    );
    const violations = lintWorkflow(workflow, rawJSON, rules, config, lintContext);
    for (const v of violations) {
      result.violations.push({ ...v, file: v.file ?? displayName, url });
      failedWorkflows.add(displayName);
    }
  }

  result.filesFailed = failedWorkflows.size;

  const outputFormat = opts.output ?? "text";
  if (outputFormat === "json") {
    console.log(formatJSON(result));
  } else {
    console.log(formatText(result));
  }

  if (hasErrors(result)) {
    process.exit(1);
  }
}

/** Lint workflow files from the local filesystem. */
async function lintLocal(
  registry: RuleRegistry,
  config: ReturnType<typeof loadLintConfig>,
  disabledRules: string[] | undefined,
  filterByTags: string[],
  opts: { dir?: string; file?: string[]; output?: string; project?: string },
): Promise<void> {
  let files: string[] = [];
  if (opts.file) {
    files = opts.file;
  } else if (opts.dir) {
    files = scanFiles(opts.dir);
  } else {
    console.error("Error: specify --dir, --file, or --remote to indicate files to lint");
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("No files found to lint");
    process.exit(1);
  }

  const result: LintResult = {
    violations: [],
    filesChecked: 0,
    filesFailed: 0,
  };

  const failedFiles = new Set<string>();

  // Load the batch first so cross-workflow rules can resolve referenced workflow IDs.
  const outcomes = await Promise.all(
    files.map((filePath) => loadFileForLint(filePath, filterByTags)),
  );
  const workflows = outcomes.flatMap((outcome) =>
    outcome.status === "loaded" && outcome.data.workflow ? [outcome.data.workflow] : [],
  );
  const lintContext = {
    workflows,
    workflowsById: new Map(
      workflows.flatMap((workflow) => (workflow.id ? [[workflow.id, workflow]] : [])),
    ),
  };

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const filePath = files[fileIndex]!;
    result.filesChecked++;

    const outcome = outcomes[fileIndex]!;
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
        result.filesChecked--;
        continue;
      }
    }

    const projectId = opts.project ?? workflowProjectId(workflow);
    const rules = registry.enabledRulesWithConfig(config, disabledRules, projectId);
    const violations = lintWorkflow(workflow, rawJSON, rules, config, lintContext);
    for (const v of violations) {
      result.violations.push({ ...v, file: v.file ?? filePath });
      failedFiles.add(filePath);
    }
  }

  result.filesFailed = failedFiles.size;

  const outputFormat = opts.output ?? "text";
  if (outputFormat === "json") {
    console.log(formatJSON(result));
  } else {
    console.log(formatText(result));
  }

  if (hasErrors(result)) {
    process.exit(1);
  }
}
