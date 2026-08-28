import { registerApplyCommand } from "./cli/commands/apply.ts";
import { registerConfigCommand } from "./cli/commands/config.ts";
import { registerConvertCommand } from "./cli/commands/convert.ts";
import { registerCredentialCommand } from "./cli/commands/credential.ts";
import { registerDataTableCommand } from "./cli/commands/data-table.ts";
import { registerDiffCommand } from "./cli/commands/diff.ts";
import { registerExecutionCommand } from "./cli/commands/execution.ts";
import { registerFmtCommand } from "./cli/commands/fmt.ts";
import { registerImportCommand } from "./cli/commands/import.ts";
import { registerLintCommand } from "./cli/commands/lint.ts";
import { registerNodeSchemaCommand } from "./cli/commands/node-schema.ts";
import { registerProxyCommand } from "./cli/commands/proxy.ts";
import { registerTagCommand } from "./cli/commands/tag.ts";
import { registerTestCommand } from "./cli/commands/test.ts";
import { registerTraceCommand } from "./cli/commands/trace.ts";
import { registerWebhookCommand } from "./cli/commands/webhook.ts";

import { registerWorkflowCommand } from "./cli/commands/workflow.ts";
import { createProgram } from "./cli/root.ts";
import { maybeShowUpdateNotice, runUpdateCheck } from "./cli/update-check.ts";

const program = createProgram();

// Kick off the update check in the background — result is persisted to the
// cache file and shown on the *next* run (keeps this run's exit path fast).
const updateCheckPromise = runUpdateCheck().catch(() => {});

// Register commands
registerWorkflowCommand(program);
registerExecutionCommand(program);
registerTagCommand(program);
registerCredentialCommand(program);
registerDataTableCommand(program);
registerApplyCommand(program);
registerDiffCommand(program);
registerConvertCommand(program);
registerImportCommand(program);
registerLintCommand(program);
registerNodeSchemaCommand(program);
registerFmtCommand(program);
registerTestCommand(program);
registerTraceCommand(program);
registerWebhookCommand(program);
registerProxyCommand(program);
registerConfigCommand(program);

try {
  await program.parseAsync(process.argv);
  await updateCheckPromise;
  maybeShowUpdateNotice();
} catch (err) {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error("Error:", err);
  }
  process.exit(1);
}
