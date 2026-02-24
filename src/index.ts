import { registerApplyCommand } from "./cli/commands/apply.ts";
import { registerExecutionCommand } from "./cli/commands/execution.ts";
import { registerFmtCommand } from "./cli/commands/fmt.ts";
import { registerImportCommand } from "./cli/commands/import.ts";
import { registerLintCommand } from "./cli/commands/lint.ts";
import { registerTestCommand } from "./cli/commands/test.ts";
import { registerWorkflowCommand } from "./cli/commands/workflow.ts";
import { createProgram } from "./cli/root.ts";

const program = createProgram();

// Register commands
registerWorkflowCommand(program);
registerExecutionCommand(program);
registerApplyCommand(program);
registerImportCommand(program);
registerLintCommand(program);
registerFmtCommand(program);
registerTestCommand(program);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error("Error:", err);
  }
  process.exit(1);
}
