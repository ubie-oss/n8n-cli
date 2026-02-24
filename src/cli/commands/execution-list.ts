import type { Command } from "commander";
import type { Execution, ExecutionStatus } from "@/api/execution-service.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerExecutionListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List workflow executions")
    .option("-w, --workflow <id>", "Filter by workflow ID")
    .option("-s, --status <status>", "Filter by status (success, error, running, waiting)")
    .option("-l, --limit <n>", "Maximum number of executions to return", "20")
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent?.parent!);

      const limit = Number.parseInt(options.limit as string, 10);
      const opts: {
        workflowId?: string;
        status?: ExecutionStatus;
        limit?: number;
      } = {};

      if (options.workflow) {
        opts.workflowId = options.workflow as string;
      }

      if (options.status) {
        opts.status = options.status as ExecutionStatus;
      }

      if (limit > 0) {
        opts.limit = limit;
      }

      const response = await ctx.executionService.listExecutions(opts);
      outputExecutions(response.data, ctx.config.output);
    });
}

function outputExecutions(executions: Execution[], format: string): void {
  if (format === "table") {
    console.log(`Found ${executions.length} execution(s)\n`);

    if (executions.length === 0) return;

    const headers = ["ID", "WORKFLOW", "STATUS", "MODE", "STARTED", "STOPPED"];
    const rows = executions.map((e) => [
      e.id,
      e.workflowId,
      formatStatus(e.status),
      e.mode,
      e.startedAt ? e.startedAt.slice(0, 19).replace("T", " ") : "-",
      e.stoppedAt ? e.stoppedAt.slice(0, 19).replace("T", " ") : "-",
    ]);
    formatTable(headers, rows);
  } else {
    formatJSON(executions, true);
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "success":
      return "✓ success";
    case "error":
      return "✗ error";
    case "running":
      return "⋯ running";
    case "waiting":
      return "◌ waiting";
    case "crashed":
      return "! crashed";
    default:
      return status;
  }
}
