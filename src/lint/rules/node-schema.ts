import type { Node, Workflow } from "@/api/types.ts";
import { outputSchemaOverrides } from "./schema-overrides.ts";

/** OutputCardinality describes how many output items a node produces */
export type OutputCardinality = "1:1" | "1:N" | "N:1" | "pass-through" | "variable";

/** OutputSchema describes the known output characteristics of a node type */
export interface OutputSchema {
  cardinality: OutputCardinality;
  /** Known fixed output fields (null = unknown) */
  fixedFields?: string[];
  /** true = fields are dynamic, skip field validation */
  dynamicFields: boolean;
  /** Derive fields from node parameters */
  parameterDerivedFields?: (params: Record<string, unknown>) => string[];
  /** Derive fields from the complete node when version/settings affect the output shape. */
  nodeDerivedFields?: (node: Node) => string[] | null;
  /** Derive cardinality from node parameters (overrides static cardinality) */
  parameterDerivedCardinality?: (params: Record<string, unknown>) => OutputCardinality;
}

/** Node output schema registry */
const nodeSchemaRegistry: Record<string, OutputSchema> = outputSchemaOverrides;

/** NodeRef represents a parsed node reference expression */
export interface NodeRef {
  nodeName: string; // e.g. "AI Agent"
  accessor: string; // "item" or "first()"
  fieldPath: string; // e.g. "output" or "output.summary"
  raw: string; // full matched string
}

/** Pattern for matching $('NodeName').item.json.field or $('NodeName').first().json.field */
const nodeRefPattern =
  /\$\(['"]([^'"]+)['"]\)\.(item|first\(\))\.json\.([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g;

/** ParseNodeRefs extracts all node reference expressions from a string */
export function parseNodeRefs(s: string): NodeRef[] {
  const refs: NodeRef[] = [];
  const re = new RegExp(nodeRefPattern.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    if (match.length >= 4) {
      refs.push({
        nodeName: match[1]!,
        accessor: match[2]!,
        fieldPath: match[3]!,
        raw: match[0],
      });
    }
  }
  return refs;
}

/** Find a node by name in the workflow */
export function getNodeByName(workflow: Workflow, name: string): Node | undefined {
  return workflow.nodes.find((n) => n.name === name);
}

/** Returns the output schema for a given node type */
export function getOutputSchema(nodeType: string): OutputSchema | undefined {
  return nodeSchemaRegistry[nodeType];
}

/** Returns the list of known output fields for a node. null if dynamic/unknown. */
export function getKnownOutputFields(node: Node): string[] | null {
  const schema = getOutputSchema(node.type);
  if (!schema) return null;
  if (schema.nodeDerivedFields) return schema.nodeDerivedFields(node);
  if (schema.dynamicFields) return null;
  if (schema.fixedFields) return schema.fixedFields;
  if (schema.parameterDerivedFields) {
    return schema.parameterDerivedFields((node.parameters as Record<string, unknown>) ?? {});
  }
  return null;
}

/** Helper: get all connections from a NodeConn (main + ai_*) */
export function getAllConnections(conn: Record<string, unknown>): Record<string, unknown[][]> {
  const result: Record<string, unknown[][]> = {};
  for (const [key, value] of Object.entries(conn)) {
    if (Array.isArray(value)) {
      result[key] = value as unknown[][];
    }
  }
  return result;
}
