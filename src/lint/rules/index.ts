import { RuleRegistry } from "../registry.ts";
import { aiAgentOutputRefRule } from "./ai-agent-output-ref.ts";
import { connectionRefRule } from "./connection-ref.ts";
import { expressionModePrefixRule } from "./expression-mode-prefix.ts";
import { implicitJsonRefRule } from "./implicit-json-ref.ts";
import { jsonSyntaxRule } from "./json-syntax.ts";
import { nodeParamsRule } from "./node-params.ts";
import { nodeRefCardinalityRule } from "./node-ref-cardinality.ts";
import { nodeRefFieldCheckRule } from "./node-ref-field-check.ts";
import { orphanedNodeRule } from "./orphaned-node.ts";
import { requiredFieldsRule } from "./required-fields.ts";
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
  registry.register(aiAgentOutputRefRule);
  registry.register(nodeParamsRule);
  registry.register(nodeRefFieldCheckRule);
  registry.register(nodeRefCardinalityRule);
  registry.register(webhookIdRequiredRule);
  return registry;
}
