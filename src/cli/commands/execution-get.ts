import type { Command } from "commander";
import type { Execution } from "@/api/execution-service.ts";
import { formatJSON } from "@/cli/output/json.ts";
import { formatKeyValue, formatTable } from "@/cli/output/table.ts";
import { resolveContext } from "@/cli/root.ts";

export function registerExecutionGetCommand(parent: Command): void {
  parent
    .command("get")
    .description("Get an execution by ID")
    .argument("<id>", "Execution ID")
    .option("--show-data", "Include full execution data in output")
    .action(async (id: string, options, command) => {
      const ctx = resolveContext(command.parent?.parent!);
      const execution = await ctx.executionService.getExecution(id);

      outputExecution(execution, ctx.config.output, options.showData as boolean);
    });
}

function outputExecution(execution: Execution, format: string, showData: boolean): void {
  if (format === "table") {
    const info: Record<string, string> = {
      ID: execution.id,
      "Workflow ID": execution.workflowId,
      Status: formatStatus(execution.status),
      Mode: execution.mode,
      Started: execution.startedAt ? execution.startedAt.slice(0, 19).replace("T", " ") : "-",
      Stopped: execution.stoppedAt ? execution.stoppedAt.slice(0, 19).replace("T", " ") : "-",
    };

    // Add error info if present
    const error = execution.data?.resultData?.error;
    if (error) {
      info["Error Node"] = error.node ?? "-";
      info["Error Message"] = error.message;
      if (error.description) {
        info["Error Details"] = truncate(error.description, 100);
      }
    }

    // Add last executed node
    const lastNode = execution.data?.resultData?.lastNodeExecuted;
    if (lastNode) {
      info["Last Node"] = lastNode;
    }

    formatKeyValue(info);

    // Show node execution summary if data available
    if (showData && execution.data?.resultData?.runData) {
      console.log("\nNode Execution Summary:");
      const runData = execution.data.resultData.runData;
      const headers = ["NODE", "TIME (ms)", "STATUS"];
      const rows: string[][] = [];

      for (const [nodeName, executions] of Object.entries(runData)) {
        for (const exec of executions) {
          const status = exec.error ? `✗ ${exec.error.message}` : "✓ success";
          rows.push([nodeName, String(exec.executionTime ?? 0), truncate(status, 40)]);
        }
      }

      if (rows.length > 0) {
        formatTable(headers, rows);
      }
    }
  } else {
    // For JSON output, optionally strip data for cleaner output
    if (!showData && execution.data) {
      const { data: _data, ...rest } = execution;
      formatJSON(rest, true);
    } else {
      formatJSON(execution, true);
    }
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

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}...`;
}
