import type { Command } from "commander";
import type { Workflow } from "../../api/types.ts";
import { extractWorkflowInputs } from "../../test/detector.ts";
import { Executor } from "../../test/executor.ts";
import { Reporter } from "../../test/reporter.ts";
import { resolveContext } from "../root.ts";

/** registerTestCommand registers the test subcommand */
export function registerTestCommand(program: Command): void {
  program
    .command("test")
    .description("Run CLI test against a workflow")
    .argument("<workflow-id>", "Workflow ID to test")
    .option("-d, --data <json>", "JSON data to send to the webhook")
    .option("--timeout <ms>", "HTTP request timeout in milliseconds", "30000")
    .option("--wait-execution", "Wait for execution to complete and show results", false)
    .option("--execution-timeout <ms>", "Max time to wait for execution (ms)", "300000")
    .option("--activate", "Automatically activate the workflow if inactive", false)
    .option("--dry-run", "Show webhook URL without executing", false)
    .option("--show-inputs", "Display workflow input parameters without executing", false)
    .action(async (workflowId: string, opts: Record<string, unknown>) => {
      const ctx = resolveContext(program);
      const reporter = new Reporter(process.stdout);

      // Get the workflow
      let workflow: Workflow;
      try {
        workflow = await ctx.workflowService.getWorkflow(workflowId);
      } catch (e) {
        console.error(
          `Error: failed to get workflow: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }

      // Show inputs mode
      if (opts.showInputs) {
        const inputs = extractWorkflowInputs(workflow);
        if (ctx.config.output === "json") {
          reporter.reportWorkflowInputsJSON(workflow, inputs);
        } else {
          reporter.reportWorkflowInputs(workflow, inputs);
        }
        return;
      }

      // Parse data
      let data: unknown = {};
      if (typeof opts.data === "string" && opts.data) {
        try {
          data = JSON.parse(opts.data);
        } catch (e) {
          console.error(`Error: invalid JSON data: ${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
      }

      const executor = new Executor(
        ctx.config.apiURL,
        ctx.workflowService,
        ctx.executionService,
        ctx.clientMiddlewares,
      );

      const result = await executor.execute(workflow, {
        data,
        timeoutMs: Number(opts.timeout),
        waitExecution: Boolean(opts.waitExecution),
        executionTimeoutMs: Number(opts.executionTimeout),
        activate: Boolean(opts.activate),
        dryRun: Boolean(opts.dryRun),
      });

      if (ctx.config.output === "json") {
        reporter.reportJSON(result);
      } else {
        reporter.report(result);
      }

      if (result.error) {
        process.exit(1);
      }
    });
}
