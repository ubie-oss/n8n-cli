import { RuleRegistry } from "../registry.ts";
import { aiAgentOutputRefRule } from "./ai-agent-output-ref.ts";
import { bannedNodeRule } from "./banned-node.ts";
import { connectionRefRule } from "./connection-ref.ts";
import {
  executeWorkflowInputsExtraRule,
  executeWorkflowInputsMissingRule,
} from "./execute-workflow-inputs.ts";
import { expressionModePrefixRule } from "./expression-mode-prefix.ts";
import {
  externalNodeRepeatedCallRule,
  externalNodeStaticRepeatedCallRule,
} from "./external-node-execution.ts";
import { filterOperatorValidRule } from "./filter-operator-valid.ts";
import { implicitJsonRefRule } from "./implicit-json-ref.ts";
import { jsonSyntaxRule } from "./json-syntax.ts";
import { mcpExposureRule } from "./mcp-exposure.ts";
import { mcpToolDescriptionRule } from "./mcp-tool-description.ts";
import { noPlaintextSecretsRule } from "./no-plaintext-secrets.ts";
import { nodeParamsRule } from "./node-params.ts";
import { nodeRefCardinalityRule } from "./node-ref-cardinality.ts";
import { nodeRefFieldCheckRule } from "./node-ref-field-check.ts";
import { orphanedNodeRule } from "./orphaned-node.ts";
import { requiredFieldsRule } from "./required-fields.ts";
import { scheduleTriggerFrequencyRule } from "./schedule-trigger-frequency.ts";
import { webhookIdRequiredRule } from "./webhook-id-required.ts";

/** Creates and returns a registry with all default rules registered */
export function registerDefaultRules(): RuleRegistry {
  const registry = new RuleRegistry();
  registry.register(jsonSyntaxRule);
  registry.register(requiredFieldsRule);
  registry.register(connectionRefRule);
  registry.register(orphanedNodeRule);
  registry.register(implicitJsonRefRule);
  registry.register(expressionModePrefixRule);
  registry.register(externalNodeRepeatedCallRule);
  registry.register(externalNodeStaticRepeatedCallRule);
  registry.register(executeWorkflowInputsExtraRule);
  registry.register(executeWorkflowInputsMissingRule);
  registry.register(aiAgentOutputRefRule);
  registry.register(nodeParamsRule);
  registry.register(nodeRefFieldCheckRule);
  registry.register(nodeRefCardinalityRule);
  registry.register(scheduleTriggerFrequencyRule);
  registry.register(webhookIdRequiredRule);
  registry.register(bannedNodeRule);
  registry.register(filterOperatorValidRule);
  registry.register(noPlaintextSecretsRule);
  registry.register(mcpToolDescriptionRule);
  registry.register(mcpExposureRule);
  return registry;
}
