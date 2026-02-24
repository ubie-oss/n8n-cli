import type { Command } from "commander";
import { registerExecutionGetCommand } from "./execution-get.ts";
import { registerExecutionListCommand } from "./execution-list.ts";

export function registerExecutionCommand(program: Command): void {
  const exec = program.command("execution").description("Manage n8n executions");
  registerExecutionListCommand(exec);
  registerExecutionGetCommand(exec);
}
