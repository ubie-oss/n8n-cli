import type { Command } from "commander";
import type { Workflow, WorkflowInput } from "../../api/types.ts";
import { readWorkflowInput } from "../../input/reader.ts";
import { runPreWriteGate } from "../../middleware/cli-gate.ts";
import { formatJSON } from "../output/json.ts";
import { formatKeyValue } from "../output/table.ts";
import { resolveContext } from "../root.ts";

export function registerUpdateCommand(parent: Command): void {
  parent
    .command("update")
    .description("Update an existing workflow")
    .argument("[id]", "Workflow ID (optional if JSON file contains 'id' field)")
    .requiredOption("-f, --file <path>", "Path to workflow JSON file (use - for stdin)")
    .option("--force", "Force update even if remote has been modified")
    .option(
      "--no-lint",
      "Skip the pre-write lint check (the check is on by default; pass to bypass on a one-off basis)",
    )
    .option(
      "--lint-config <path>",
      "Path to .n8nlintrc.json for the pre-write lint check (auto-discovered if omitted)",
    )
    .option(
      "--lint-disable-rule <rules>",
      "Comma-separated rule names to disable during the pre-write lint check",
    )
    .action(async (id: string | undefined, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      // Catch reader validation errors and surface them as CLI errors so
      // missing-required-field cases produce a consistent message instead of
      // a raw stack trace. See workflow-create.ts for the same pattern.
      let input: WorkflowInput;
      try {
        input = await readWorkflowInput(options.file as string);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${options.file as string}: ${message}`);
        process.exit(1);
      }

      // Resolve workflow ID: argument > file content.
      // Defer the "Using workflow ID from file" log until AFTER the lint gate
      // — otherwise a lint failure prints that line first and reads as
      // "update started, then failed" to humans and stdout scrapers, when in
      // reality nothing was sent upstream.
      let workflowID = id;
      let workflowIDFromFile = false;
      if (!workflowID) {
        const rawData = await readRawID(options.file as string);
        if (!rawData) {
          console.error(
            "Error: workflow ID is required: specify as argument or include 'id' field in the JSON file",
          );
          process.exit(1);
        }
        workflowID = rawData;
        workflowIDFromFile = true;
      }

      await runPreWriteGate({
        source: options.file as string,
        workflow: input,
        noLint: options.lint === false,
        lintConfigPath: typeof options.lintConfig === "string" ? options.lintConfig : undefined,
        lintDisableRules:
          typeof options.lintDisableRule === "string"
            ? (options.lintDisableRule as string)
                .split(",")
                .map((r) => r.trim())
                .filter((r) => r.length > 0)
            : undefined,
      });

      if (workflowIDFromFile) {
        console.log(`Using workflow ID from file: ${workflowID}`);
      }

      const workflow = await ctx.workflowService.updateWorkflow(workflowID!, input);

      console.log(`Workflow ${workflow.name} (${workflow.id}) updated successfully`);
      outputWorkflow(workflow, ctx.config.output);
    });
}

async function readRawID(filename: string): Promise<string | undefined> {
  if (filename === "-" || filename === "") return undefined;
  try {
    const text = await Bun.file(filename).text();
    const parsed = JSON.parse(text) as { id?: string };
    return parsed.id || undefined;
  } catch {
    return undefined;
  }
}

function outputWorkflow(workflow: Workflow, format: string): void {
  if (format === "table") {
    formatKeyValue({
      ID: workflow.id ?? "-",
      Name: workflow.name,
      Active: workflow.active ? "Yes" : "No",
      Nodes: String(workflow.nodes?.length ?? 0),
      Created: workflow.createdAt ? workflow.createdAt.slice(0, 19).replace("T", " ") : "-",
      Updated: workflow.updatedAt ? workflow.updatedAt.slice(0, 19).replace("T", " ") : "-",
    });
  } else {
    formatJSON(workflow, true);
  }
}
