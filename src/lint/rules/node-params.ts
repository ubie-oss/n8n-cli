import type { INodeParameters, INodeProperties } from "n8n-workflow";
import { getNodeParameters } from "n8n-workflow";
import type { Node, Workflow } from "@/api/types.ts";
import type { NodeTypeSchema, ParamType } from "./node-params-schema.ts";
import { lookupSchemas, matchesCondition } from "./node-params-schema.ts";
import { lookupRawProperties } from "./node-properties-loader.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/** Validates node parameters against known schemas */
export const nodeParamsRule: Rule = {
  name: "node-params",
  description:
    "Check node parameters match expected schema (required params, credentials, types, enums)",
  defaultSeverity: "warning",
  check(workflow: Workflow | null, _rawJSON: string): Violation[] {
    if (!workflow) return [];

    const violations: Violation[] = [];
    for (const node of workflow.nodes) {
      const schemas = lookupSchemas(node.type, node.typeVersion);
      for (const schema of schemas) {
        if (!matchesCondition(schema, (node.parameters as Record<string, unknown>) ?? {})) continue;
        violations.push(...checkNode(node, schema));
      }

      // Validate parameter structure using n8n-workflow's getNodeParameters
      const rawProps = lookupRawProperties(node.type, node.typeVersion);
      if (rawProps && node.parameters) {
        try {
          getNodeParameters(
            rawProps as INodeProperties[],
            node.parameters as INodeParameters,
            false,
            false,
            { typeVersion: node.typeVersion },
            null,
          );
        } catch (e) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    }
    return violations;
  },
};

function checkNode(node: Node, schema: NodeTypeSchema): Violation[] {
  const violations: Violation[] = [];
  const params = (node.parameters as Record<string, unknown>) ?? {};

  // 1. Credential check
  if (schema.requiresCredentials && !node.credentials) {
    violations.push({
      rule: "node-params",
      severity: "warning",
      message: `Node "${node.name}" (${node.type}): missing credentials`,
    });
  }

  // 2-5. Parameter checks
  if (schema.params) {
    for (const [paramName, paramSchema] of Object.entries(schema.params)) {
      const raw = params[paramName];
      const exists = raw !== undefined;

      // 2. Required check
      if (paramSchema.required) {
        if (!exists) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): missing required parameter "${paramName}"`,
          });
          continue;
        }
        if (isEmpty(raw)) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): required parameter "${paramName}" is empty`,
          });
          continue;
        }
      }

      if (!exists) continue;

      // Skip expression values for type/enum checks
      if (isExpression(raw)) continue;

      // 3. Type check
      if (paramSchema.type && paramSchema.type !== "any") {
        if (!matchesType(raw, paramSchema.type)) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): parameter "${paramName}" expected type ${paramSchema.type}`,
          });
          continue;
        }
      }

      // 4. Enum check
      if (paramSchema.allowedValues && paramSchema.allowedValues.length > 0) {
        if (typeof raw === "string") {
          if (!paramSchema.allowedValues.includes(raw)) {
            violations.push({
              rule: "node-params",
              severity: "warning",
              message: `Node "${node.name}" (${node.type}): parameter "${paramName}" has invalid value "${raw}" (allowed: ${paramSchema.allowedValues.join(", ")})`,
            });
          }
        }
      }

      // 5. NestedRequired check
      if (paramSchema.nestedRequired && paramSchema.nestedRequired.length > 0) {
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const obj = raw as Record<string, unknown>;
          for (const key of paramSchema.nestedRequired) {
            const nestedVal = obj[key];
            if (nestedVal === undefined) {
              violations.push({
                rule: "node-params",
                severity: "warning",
                message: `Node "${node.name}" (${node.type}): parameter "${paramName}" is missing nested key "${key}"`,
              });
            } else if (isEmpty(nestedVal)) {
              violations.push({
                rule: "node-params",
                severity: "warning",
                message: `Node "${node.name}" (${node.type}): parameter "${paramName}" has empty nested key "${key}"`,
              });
            }
          }
        }
      }
    }
  }

  // 6. OptionsParams check
  if (schema.optionsParams) {
    const optionsRaw = params.options;
    const optionsMap =
      optionsRaw && typeof optionsRaw === "object" && !Array.isArray(optionsRaw)
        ? (optionsRaw as Record<string, unknown>)
        : null;

    for (const [optParamName, optParamSchema] of Object.entries(schema.optionsParams)) {
      if (optParamSchema.required) {
        if (!optionsMap) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): missing required option "${optParamName}" in options`,
          });
          continue;
        }
        const val = optionsMap[optParamName];
        if (val === undefined) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): missing required option "${optParamName}" in options`,
          });
        } else if (isEmpty(val)) {
          violations.push({
            rule: "node-params",
            severity: "warning",
            message: `Node "${node.name}" (${node.type}): required option "${optParamName}" in options is empty`,
          });
        }
      }
    }
  }

  return violations;
}

function isExpression(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (v.startsWith("=")) return true;
  if (v.includes("{{") && v.includes("}}")) return true;
  return false;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") {
    if (isExpression(v)) return false;
    return v === "";
  }
  if (typeof v === "object") {
    if (Array.isArray(v)) return v.length === 0;
    return Object.keys(v).length === 0;
  }
  return false;
}

function matchesType(v: unknown, expected: ParamType): boolean {
  switch (expected) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "any":
      return true;
    default:
      return false;
  }
}
