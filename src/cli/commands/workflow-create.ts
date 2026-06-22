import type { Command } from "commander";
import type { Workflow, WorkflowInput } from "../../api/types.ts";
import { readWorkflowInput } from "../../input/reader.ts";
import { runPreWriteLintGate } from "../../lint/cli-gate.ts";
import { formatJSON } from "../output/json.ts";
import { formatKeyValue } from "../output/table.ts";
import { resolveContext } from "../root.ts";

export function registerCreateCommand(parent: Command): void {
  parent
    .command("create")
    .description("Create a new workflow")
    .requiredOption("-f, --file <path>", "Path to workflow JSON file (use - for stdin)")
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
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      // `readWorkflowInput` runs `validateWorkflowInput`, which throws raw
      // Errors for missing name/nodes/connections. Those overlap with the
      // lint `required-fields` rule. Re-frame as a CLI error so the user
      // gets a consistent message (and the `--no-lint` hint isn't needed
      // here because validation guards write integrity, not lint policy).
      let input: WorkflowInput;
      try {
        input = await readWorkflowInput(options.file as string);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${options.file as string}: ${message}`);
        process.exit(1);
      }

      runPreWriteLintGate({
        source: options.file as string,
        workflow: input,
        noLint: options.lint === false,
        configPath: typeof options.lintConfig === "string" ? options.lintConfig : undefined,
        disableRules:
          typeof options.lintDisableRule === "string"
            ? (options.lintDisableRule as string)
                .split(",")
                .map((r) => r.trim())
                .filter((r) => r.length > 0)
            : undefined,
      });

      const workflow = await ctx.workflowService.createWorkflow(input);

      console.log("Workflow created successfully");
      outputWorkflow(workflow, ctx.config.output);
    });
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
