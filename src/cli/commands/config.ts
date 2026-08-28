import type { Command } from "commander";
import { resolveConfig } from "@/cli/root.ts";
import { loadRc } from "@/config/rc.ts";

/**
 * `config` — inspect the all-in-one configuration without touching the n8n
 * API. Complements `--config` / N8NCTL_CONFIG with the two questions every
 * operator eventually asks: "what does the CLI actually see?" (show) and
 * "is my config file well-formed?" (check).
 */
export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description(
      "Inspect the all-in-one configuration (.n8nctlrc.json, ~/.config/n8nctl/config.json)",
    );

  const configFlag = () => (program.opts() as { config?: string }).config;

  config
    .command("show")
    .description("Print the effective merged configuration (secrets masked)")
    .option("--reveal-secrets", "Print api.apiKey unmasked (default: masked as ***)")
    .action((opts: { revealSecrets?: boolean }) => {
      let rc: ReturnType<typeof loadRc>;
      let effective: ReturnType<typeof resolveConfig>;
      try {
        rc = loadRc({ configPath: configFlag() });
        effective = resolveConfig(program);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const mask = (key: string) => (key ? (opts.revealSecrets ? key : "***") : "");
      console.log(
        JSON.stringify(
          {
            sources: rc.sources,
            effective: {
              apiURL: effective.apiURL,
              apiKey: mask(effective.apiKey),
              timeoutMs: effective.timeoutMs,
              output: effective.output,
              middlewares: rc.config.middlewares ?? {},
              proxy: rc.config.proxy ?? {},
            },
            file: {
              ...rc.config,
              api: rc.config.api
                ? { ...rc.config.api, apiKey: mask(rc.config.api.apiKey ?? "") }
                : undefined,
            },
          },
          null,
          2,
        ),
      );
    });

  config
    .command("check")
    .description(
      "Validate configuration files: JSON syntax, section shape, ${ENV_VAR} resolution. " +
        "Exit code 0 when usable, 1 when not — safe for CI.",
    )
    .action(() => {
      try {
        const rc = loadRc({ configPath: configFlag() });
        const loaded: string[] = [];
        if (rc.sources.explicit) loaded.push(`explicit: ${rc.sources.explicit}`);
        if (rc.sources.user) loaded.push(`user: ${rc.sources.user}`);
        if (rc.sources.project) loaded.push(`project: ${rc.sources.project}`);
        if (loaded.length === 0) {
          console.log("No configuration file found (defaults in effect). OK");
          return;
        }
        for (const line of loaded) console.log(`OK ${line}`);
        if (rc.config.api?.apiKey) {
          console.log("OK api.apiKey resolves (value not printed)");
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
