import generatedSchemas from "@/generated/node-schemas.json";
import { paramSchemaOverrides } from "./schema-overrides.ts";

/** ParamType represents the expected JSON type of a parameter value */
export type ParamType = "string" | "number" | "boolean" | "object" | "array" | "any";

/** ParamSchema describes validation rules for a single node parameter */
export interface ParamSchema {
  required?: boolean;
  type?: ParamType;
  allowedValues?: string[];
  nestedRequired?: string[];
}

/** NodeTypeSchema describes validation rules for a specific n8n node type */
export interface NodeTypeSchema {
  nodeType: string;
  minVersion?: number;
  maxVersion?: number;
  requiresCredentials?: boolean;
  params?: Record<string, ParamSchema>;
  conditionParam?: string;
  conditionValue?: string;
  optionsParams?: Record<string, ParamSchema>;
}

// ---------------------------------------------------------------------------
// Build schema index from generated JSON + overrides
// ---------------------------------------------------------------------------

interface GeneratedParamSchema {
  required?: boolean;
  type?: ParamType;
  allowedValues?: string[];
  nestedRequired?: string[];
}

interface GeneratedNodeTypeSchema {
  nodeType: string;
  versions: number[];
  requiresCredentials?: boolean;
  params: Record<string, GeneratedParamSchema>;
  conditionParam?: string;
  conditionValue?: string;
}

interface GeneratedOutput {
  paramSchemas: Record<string, GeneratedNodeTypeSchema[]>;
}

/** Convert a generated schema entry into NodeTypeSchema(s) with version ranges */
function toNodeTypeSchemas(gen: GeneratedNodeTypeSchema): NodeTypeSchema {
  const schema: NodeTypeSchema = {
    nodeType: gen.nodeType,
  };

  if (gen.requiresCredentials) {
    schema.requiresCredentials = true;
  }

  if (gen.versions.length > 0) {
    schema.minVersion = Math.min(...gen.versions);
    schema.maxVersion = Math.max(...gen.versions);
  }

  if (gen.conditionParam) {
    schema.conditionParam = gen.conditionParam;
    schema.conditionValue = gen.conditionValue ?? "";
  }

  // Only include params that have meaningful validation rules
  const params: Record<string, ParamSchema> = {};
  for (const [name, ps] of Object.entries(gen.params)) {
    if (ps.required || ps.allowedValues || ps.nestedRequired) {
      params[name] = { ...ps };
    }
  }
  if (Object.keys(params).length > 0) {
    schema.params = params;
  }

  return schema;
}

function buildSchemaIndex(
  generated: GeneratedOutput,
  overrides: Record<string, NodeTypeSchema[]>,
): Map<string, NodeTypeSchema[]> {
  const index = new Map<string, NodeTypeSchema[]>();

  // Load from generated JSON
  for (const [nodeType, genSchemas] of Object.entries(generated.paramSchemas)) {
    const schemas = genSchemas.map(toNodeTypeSchemas);
    index.set(nodeType, schemas);
  }

  // Apply overrides: replace generated schemas entirely for overridden nodes.
  // nodes.json has complex displayOptions that don't always map cleanly
  // to our simpler condition model, so curated overrides take full precedence.
  for (const [nodeType, overrideSchemas] of Object.entries(overrides)) {
    index.set(nodeType, overrideSchemas);
  }

  return index;
}

/** Schema index: maps node type to its schemas */
const schemaIndex = buildSchemaIndex(
  generatedSchemas as unknown as GeneratedOutput,
  paramSchemaOverrides,
);

/** Returns all matching schemas for a given node type and version */
export function lookupSchemas(nodeType: string, typeVersion: number): NodeTypeSchema[] {
  const candidates = schemaIndex.get(nodeType);
  if (!candidates) return [];

  return candidates.filter((s) => {
    if (s.minVersion != null && typeVersion < s.minVersion) return false;
    if (s.maxVersion != null && typeVersion > s.maxVersion) return false;
    return true;
  });
}

/** Checks if a schema's condition matches the node's parameters */
export function matchesCondition(schema: NodeTypeSchema, params: Record<string, unknown>): boolean {
  if (!schema.conditionParam) return true;
  let paramVal = "";
  const v = params[schema.conditionParam];
  if (typeof v === "string") paramVal = v;
  return paramVal === (schema.conditionValue ?? "");
}
