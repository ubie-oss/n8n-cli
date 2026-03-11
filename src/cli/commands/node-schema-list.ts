import type { Command } from "commander";
import { formatJSON } from "@/cli/output/json.ts";
import { formatTable } from "@/cli/output/table.ts";
import type { NodeDescription } from "./node-schema-types.ts";

export function registerNodeSchemaListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List all built-in node types")
    .option("--output <format>", "Output format: table or json", "table")
    .option("--group <name>", "Filter by group name")
    .action(async (options) => {
      const descriptions: NodeDescription[] = (await import("@/generated/node-descriptions.json"))
        .default;

      let filtered = descriptions;
      if (options.group) {
        const group = options.group as string;
        filtered = descriptions.filter((d) => d.group.includes(group));
      }

      if (options.output === "json") {
        const summary = filtered.map((d) => ({
          nodeType: d.nodeType,
          displayName: d.displayName,
          description: d.description,
          versions: d.versions,
          group: d.group,
          hasCredentials: (d.credentials?.length ?? 0) > 0,
        }));
        formatJSON(summary, true);
      } else {
        console.log(`Found ${filtered.length} node type(s)\n`);
        if (filtered.length === 0) return;

        const headers = ["NODE TYPE", "DISPLAY NAME", "VERSIONS", "GROUP"];
        const rows = filtered.map((d) => [
          d.nodeType,
          d.displayName,
          d.versions.join(","),
          d.group.join(","),
        ]);
        formatTable(headers, rows);
      }
    });
}
