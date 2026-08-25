import path from "node:path";
import type { Command } from "commander";
import type { Workflow } from "@/api/types.ts";
import { Scanner } from "@/apply/scanner.ts";
import { parseDiffSpec } from "@/apply/threeway/diffspec.ts";
import { defaultApplyOptions } from "@/apply/types.ts";
import { resolveConfig, resolveContext } from "@/cli/root.ts";
import { formatDiffMermaid, formatDiffStat, formatDiffText } from "@/diff/format.ts";
import { formatDiffHtml } from "@/diff/format-html.ts";
import type { DiffOptions, DiffReport } from "@/diff/model.ts";
import { buildReport } from "@/diff/report.ts";
import { loadWorkflowContent, loadWorkflowFile } from "@/diff/sources.ts";
import { ContentRetriever, ErrFileNotExist } from "@/git/content.ts";
import { Detector } from "@/git/detector.ts";

/**
 * Exit code contract (designed for CI and AI self-verification):
 *   0 = no differences
 *   1 = differences found
 *   2 = could not compute a diff at all (bad input, API error, ...)
 */
const EXIT_NO_CHANGES = 0;
const EXIT_HAS_CHANGES = 1;
const EXIT_ERROR = 2;

interface DiffCommandOptions {
  dir: string;
  gitSpec?: string;
  ids?: string;
  stat: boolean;
  format: string;
  includePosition: boolean;
}

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Compare workflow definitions and show what changed. Read-only; never writes.")
    .argument("[left]", "Old side: workflow file (.json/.yaml/.ts). Omit to use --dir / server")
    .argument("[right]", "New side: workflow file. Requires [left]")
    .option(
      "-d, --dir <path>",
      "Definitions directory used by server/git comparisons",
      "./definitions",
    )
    .option(
      "--git-spec <spec>",
      "Compare files at the base ref of SPEC (e.g. origin/main...HEAD) against the working tree",
    )
    .option("--ids <ids>", "Comma-separated workflow IDs to include")
    .option("--stat", "Print only per-workflow summary lines")
    .option("-f, --format <format>", "Output format: text, json, mermaid, html", "text")
    .option("--include-position", "Report node position changes instead of ignoring them")
    .action(async (left, right, options: DiffCommandOptions, command) => {
      // exitCode instead of process.exit(): exit() terminates before piped
      // stdout has flushed, silently truncating redirected html/json output.
      try {
        process.exitCode = await runDiff(left, right, options, command);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = EXIT_ERROR;
      }
    });
}

/**
 * Executes the diff and returns the process exit code (0/1/2). Exported for
 * tests; the commander action is a thin wrapper around this.
 */
export async function runDiff(
  left: string | undefined,
  right: string | undefined,
  options: DiffCommandOptions,
  command: Command,
): Promise<number> {
  const opts: DiffOptions = { includePosition: !!options.includePosition };
  const format = options.format;
  if (!["text", "json", "mermaid", "html"].includes(format)) {
    throw new Error(`unsupported --format "${format}" (expected text, json, mermaid or html)`);
  }

  let report: DiffReport;
  if (left && right) {
    report = buildReport([fileEntry(left)], [fileEntry(right)], opts);
  } else if (left || right) {
    throw new Error("both LEFT and RIGHT files are required when comparing files");
  } else if (options.gitSpec) {
    report = await compareAgainstGitRef(options.gitSpec, options.dir, options.ids, opts);
  } else {
    report = await compareDirVsServer(options.dir, options.ids, opts, command);
  }

  print(report, format, !!options.stat);
  return report.hasChanges ? EXIT_HAS_CHANGES : EXIT_NO_CHANGES;
}

function fileEntry(filePath: string): { workflow: Workflow; source: string } {
  return { workflow: loadWorkflowFile(filePath), source: filePath };
}

function parseIDFilter(idsOption: string | undefined): string[] {
  return (idsOption ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Directory vs n8n server
// ---------------------------------------------------------------------------

async function compareDirVsServer(
  dir: string,
  idsOption: string | undefined,
  opts: DiffOptions,
  command: Command,
): Promise<DiffReport> {
  // resolveContext() exits the process on missing API config, which would
  // violate the diff exit-code contract (2 = could not compute). Check the
  // essentials first so the action's error path produces a clean exit 2.
  const config = resolveConfig(command.parent!);
  if (!config.apiURL || !config.apiKey) {
    throw new Error("N8N_API_URL and N8N_API_KEY are required to compare against a server");
  }

  const ctx = resolveContext(command.parent!);

  const scanOpts = defaultApplyOptions();
  scanOpts.directory = dir;
  // Definitions are usually YAML-first; TS stays opt-in like apply does.
  scanOpts.yamlEnabled = true;
  scanOpts.tsEnabled = true;
  const ids = parseIDFilter(idsOption);
  scanOpts.ids = ids;

  const localFiles = await new Scanner().scanWithOptions(scanOpts);
  const left: Array<{ workflow: Workflow; source?: string }> = [];
  const right: Array<{ workflow: Workflow; source?: string }> = [];

  for (const f of localFiles) {
    if (f.error) throw f.error;
    if (f.workflow) left.push({ workflow: f.workflow, source: path.basename(f.path) });
  }
  const remotes = await ctx.workflowService.listAllWorkflows();
  right.push(...remotes.map((wf) => ({ workflow: wf, source: "server" })));

  const report = buildReport(left, right, opts);
  // With an explicit ID filter, unrelated remote-only workflows are out of
  // scope rather than surprising removals.
  if (ids.length > 0) {
    report.comparisons = report.comparisons.filter((c) => c.status !== "removed");
    report.hasChanges = report.comparisons.some((c) => c.status !== "unchanged");
  }
  return report;
}

// ---------------------------------------------------------------------------
// Git ref vs working tree
// ---------------------------------------------------------------------------

async function compareAgainstGitRef(
  spec: string,
  dir: string,
  idsOption: string | undefined,
  opts: DiffOptions,
): Promise<DiffReport> {
  const parsed = parseDiffSpec(spec);
  const detector = new Detector();
  const retriever = new ContentRetriever();
  const repoRoot = await detector.getRepoRoot();

  // Reuse apply's change detection so both commands agree on what counts as a
  // changed workflow file.
  const scanOpts = defaultApplyOptions();
  scanOpts.directory = dir;
  scanOpts.yamlEnabled = true;
  scanOpts.tsEnabled = true;
  scanOpts.fromGitChanges = true;
  scanOpts.gitDiffSpec = spec;
  scanOpts.ids = parseIDFilter(idsOption);

  const changedFiles = await new Scanner().scanWithOptions(scanOpts);
  const left: Array<{ workflow: Workflow; source?: string }> = [];
  const right: Array<{ workflow: Workflow; source?: string }> = [];

  for (const f of changedFiles) {
    const relPath = path.relative(repoRoot, f.path);
    const baseSource = `${parsed.baseRef}:${relPath}`;

    let baseWorkflow: Workflow | null = null;
    try {
      const content = await retriever.getFileAtRef(parsed.baseRef, relPath);
      baseWorkflow = loadWorkflowContent(content, relPath);
    } catch (err) {
      if (err === ErrFileNotExist) {
        baseWorkflow = null; // new file: the right side alone reports as added
      } else if (err instanceof Error && /ENOENT|no such file/i.test(err.message)) {
        throw new Error(
          `${baseSource}: definition references external files that do not exist at this ref; git comparison supports self-contained definitions only`,
        );
      } else {
        throw err;
      }
    }

    if (baseWorkflow) {
      left.push({ workflow: baseWorkflow, source: baseSource });
    }
    if (f.workflow) {
      right.push({ workflow: f.workflow, source: path.basename(f.path) });
    }
  }

  return buildReport(left, right, opts);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function print(report: DiffReport, format: string, statOnly: boolean): void {
  switch (format) {
    case "json":
      console.log(JSON.stringify(report, null, 2));
      break;
    case "mermaid":
      console.log(formatDiffMermaid(report) || "No differences found.");
      break;
    case "html":
      // Written to stdout so callers choose the destination: `> report.html`.
      process.stdout.write(formatDiffHtml(report));
      break;
    default:
      console.log(statOnly ? formatDiffStat(report) : formatDiffText(report, statOnly));
  }
}
