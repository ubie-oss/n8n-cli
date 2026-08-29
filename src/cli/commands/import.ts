import type { Command } from "commander";
import { deriveMcpEndpointUrl, McpClient } from "../../api/mcp-client.ts";
import {
  getEffectiveExternalizeThreshold,
  getEffectiveTsEnabled,
  getEffectiveYamlEnabled,
  loadCLIConfig,
} from "../../config/claude-md.ts";
import { resolveMcpClientSettings } from "../../config/mcp.ts";
import { ImportExecutor } from "../../importer/executor.ts";
import { McpFolderSource } from "../../importer/folder-source.ts";
import { reportDryRun, reportProgress, reportSummary } from "../../importer/reporter.ts";
import { defaultImportOptions, type ImportOptions } from "../../importer/types.ts";
import { loadMergedRc, resolveContext } from "../root.ts";

export function registerImportCommand(parent: Command): void {
  parent
    .command("import")
    .description("Import workflows from n8n to local files")
    .option("--dry-run", "Preview changes without writing files", false)
    .option("-d, --dir <directory>", "Target directory for workflow files", "./definitions")
    .option("--ids <ids>", "Comma-separated workflow IDs to import (empty = all)")
    .option("--include-archived", "Include archived workflows", false)
    // Neither format flag carries a default value. With one, commander reports
    // `false` even when the flag was never passed, which is indistinguishable
    // from `--no-yaml` / `--no-ts` and makes the CLAUDE.md setting unreachable.
    .option("--yaml", "Output as YAML format with external files")
    .option("--no-yaml", "Force JSON format output")
    .option("--ts", "Output new workflows as .ts (@n8n/workflow-sdk format)")
    .option("--no-ts", "Do not write .ts output")
    .option("-t, --threshold <n>", "Minimum lines for code externalization", "0")
    .option("--cleanup-orphans", "Delete local files without matching remote workflow", false)
    .option("--cleanup-subfiles", "Delete orphan external files in _subfiles directories", false)
    .option("--tags <tags>", "Filter by tags (comma-separated, AND condition)")
    .option(
      "--mcp",
      "Attach folder assignments to imported files by calling n8n's MCP server (enabled automatically by --mcp-token or N8N_MCP_TOKEN)",
    )
    .option(
      "--mcp-token <token>",
      "MCP access token for the folder lookup (env: N8N_MCP_TOKEN). Without a token, MCP calls rely on an n8n-cli proxy injecting the token for /mcp-server/*",
    )
    .option(
      "--mcp-strict",
      "Fail the import when the MCP folder lookup fails, instead of warning and continuing without folder information",
    )
    .action(async (options, command) => {
      const ctx = resolveContext(command.parent!);
      const cliConfig = loadCLIConfig();

      // MCP client settings: flags win over N8N_MCP_TOKEN / N8N_MCP, which win
      // over the `mcp` section of .n8nctlrc.json. Folder lookups only happen
      // when this resolves to enabled.
      const rc = loadMergedRc(command.parent!.opts().config);
      const mcpSettings = resolveMcpClientSettings({
        flagEnabled: options.mcp === true,
        ...(typeof options.mcpToken === "string" ? { flagToken: options.mcpToken } : {}),
        flagStrict: options.mcpStrict === true,
        rc: rc.config.mcp,
      });

      // The flags carry no default, so `undefined` means "not passed" and the
      // CLAUDE.md setting decides.
      const yamlFlag = options.yaml === true;
      const noYamlFlag = options.yaml === false;
      const tsFlag = options.ts === true;
      const noTsFlag = options.ts === false;

      // Unlike apply — which scans every enabled format — import writes one
      // format per new workflow, so asking for two is a mistake worth catching
      // rather than resolving by an invisible precedence rule.
      if (yamlFlag && tsFlag) {
        console.error("Error: --yaml and --ts cannot be used together");
        process.exit(1);
      }

      const importOpts: ImportOptions = {
        ...defaultImportOptions(),
        directory: options.dir as string,
        dryRun: options.dryRun as boolean,
        includeArchived: options.includeArchived as boolean,
        yamlEnabled: getEffectiveYamlEnabled(yamlFlag, noYamlFlag, cliConfig),
        tsEnabled: getEffectiveTsEnabled(tsFlag, noTsFlag, cliConfig),
        externalizeThreshold: getEffectiveExternalizeThreshold(
          Number.parseInt(options.threshold as string, 10) || 0,
          cliConfig,
        ),
        cleanupOrphans: options.cleanupOrphans as boolean,
        cleanupSubfiles: options.cleanupSubfiles as boolean,
        ids: options.ids
          ? (options.ids as string)
              .split(",")
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0)
          : [],
        filterByTags: options.tags
          ? (options.tags as string)
              .split(",")
              .map((s: string) => s.trim())
              .filter((s: string) => s.length > 0)
          : [],
        mcpStrict: mcpSettings.strict,
      };

      const executor = new ImportExecutor(ctx.workflowService, importOpts);
      executor.setProgressCallback(reportProgress);

      // Folder assignments ride on an MCP connection (direct token or proxy
      // injection). Failure degrades to a warning unless --mcp-strict.
      if (mcpSettings.enabled) {
        const mcpClient = new McpClient({
          endpointUrl: deriveMcpEndpointUrl(ctx.config.apiURL),
          ...(mcpSettings.token ? { token: mcpSettings.token } : {}),
          timeoutMs: ctx.config.timeoutMs,
          // Same egress chain as REST / webhook: IAP in front of the proxy
          // must see MCP calls too, or folder lookups 403 while import itself
          // succeeds and the assignment silently disappears.
          clientMiddlewares: ctx.clientMiddlewares,
        });
        executor.setFolderSource(new McpFolderSource(mcpClient, ctx.folderService));
        if (mcpSettings.mode === "proxy") {
          console.log("Folder lookup via MCP (proxy mode — token injected by the proxy)");
        }
      }

      try {
        const result = await executor.execute();

        if (importOpts.dryRun) {
          reportDryRun(result);
        } else {
          reportSummary(result);
        }

        if (result.hasErrors()) {
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
