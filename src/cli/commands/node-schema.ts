import type { Command } from "commander";
import { registerNodeSchemaListCommand } from "./node-schema-list.ts";
import { registerNodeSchemaDumpCommand } from "./node-schema-dump.ts";

export function registerNodeSchemaCommand(program: Command): void {
  const ns = program.command("node-schema").description("Inspect built-in node type schemas");
  registerNodeSchemaListCommand(ns);
  registerNodeSchemaDumpCommand(ns);
}
