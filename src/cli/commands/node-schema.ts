import type { Command } from "commander";
import { registerNodeSchemaDumpCommand } from "./node-schema-dump.ts";
import { registerNodeSchemaListCommand } from "./node-schema-list.ts";

export function registerNodeSchemaCommand(program: Command): void {
  const ns = program.command("node-schema").description("Inspect built-in node type schemas");
  registerNodeSchemaListCommand(ns);
  registerNodeSchemaDumpCommand(ns);
}
