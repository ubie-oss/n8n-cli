import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { formatJSON } from "@/cli/output/json.ts";
import type { NodeDescription } from "./node-schema-types.ts";

function buildIndex(descriptions: NodeDescription[]): object {
  return {
    generatedAt: new Date().toISOString(),
    count: descriptions.length,
    nodes: descriptions.map((d) => ({
      nodeType: d.nodeType,
      displayName: d.displayName,
      description: d.description,
      versions: d.versions,
      group: d.group,
      hasCredentials: (d.credentials?.length ?? 0) > 0,
    })),
  };
}

export function registerNodeSchemaDumpCommand(parent: Command): void {
  parent
    .command("dump")
    .description("Dump full node type schemas")
    .option("--type <nodeType>", "Specific node type (e.g. n8n-nodes-base.slack)")
    .option("-o, --output-dir <dir>", "Output directory for file dump")
    .action(async (options) => {
      const descriptions: NodeDescription[] = (await import("@/generated/node-descriptions.json"))
        .default;
      const typeFilter = options.type as string | undefined;
      const outputDir = options.outputDir as string | undefined;

      if (typeFilter) {
        const node = descriptions.find((d) => d.nodeType === typeFilter);
        if (!node) {
          console.error(`Error: Node type "${typeFilter}" not found`);
          process.exit(1);
        }

        if (outputDir) {
          dumpToDirectory(outputDir, [node]);
        } else {
          formatJSON(node, true);
        }
      } else {
        if (outputDir) {
          dumpToDirectory(outputDir, descriptions);
        } else {
          formatJSON(buildIndex(descriptions), true);
        }
      }
    });
}

function dumpToDirectory(dir: string, descriptions: NodeDescription[]): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  console.error(`Dumping ${descriptions.length} node schema(s)...`);

  for (const desc of descriptions) {
    const safeFileName = desc.nodeType.replaceAll("/", "__");
    const filePath = path.join(dir, `${safeFileName}.json`);
    writeFileSync(filePath, JSON.stringify(desc, null, 2));
  }

  const indexPath = path.join(dir, "_index.json");
  writeFileSync(indexPath, JSON.stringify(buildIndex(descriptions), null, 2));

  console.error(`Done. Files written to ${dir}/`);
}
