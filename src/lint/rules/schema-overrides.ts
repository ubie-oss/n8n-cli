import type { NodeTypeSchema } from "./node-params-schema.ts";
import type { OutputSchema } from "./node-schema.ts";

/**
 * Output schema overrides.
 *
 * cardinality, dynamicFields, fixedFields, parameterDerivedFields are
 * not extractable from n8n nodes.json, so they are manually defined here.
 */
export const outputSchemaOverrides: Record<string, OutputSchema> = {
  "@n8n/n8n-nodes-langchain.agent": {
    cardinality: "1:1",
    fixedFields: ["output"],
    dynamicFields: false,
  },
  "n8n-nodes-base.googleBigQuery": {
    cardinality: "1:N",
    dynamicFields: true,
  },
  "n8n-nodes-base.aggregate": {
    cardinality: "N:1",
    dynamicFields: false,
    parameterDerivedFields: aggregateOutputFields,
  },
  "n8n-nodes-base.set": { cardinality: "pass-through", dynamicFields: true },
  "n8n-nodes-base.filter": {
    cardinality: "pass-through",
    dynamicFields: true,
  },
  "n8n-nodes-base.if": { cardinality: "pass-through", dynamicFields: true },
  "n8n-nodes-base.switch": {
    cardinality: "pass-through",
    dynamicFields: true,
  },
  "n8n-nodes-base.noOp": { cardinality: "pass-through", dynamicFields: true },
  "n8n-nodes-base.splitInBatches": {
    cardinality: "1:1",
    dynamicFields: true,
  },
  "n8n-nodes-base.code": { cardinality: "variable", dynamicFields: true },
  "n8n-nodes-base.httpRequest": {
    cardinality: "variable",
    dynamicFields: true,
  },
  "n8n-nodes-base.webhook": { cardinality: "1:1", dynamicFields: true },
  "n8n-nodes-base.executeWorkflowTrigger": {
    cardinality: "1:1",
    dynamicFields: true,
  },
  "n8n-nodes-base.slack": { cardinality: "1:1", dynamicFields: true },
  "n8n-nodes-base.merge": { cardinality: "variable", dynamicFields: true },
  "n8n-nodes-base.notion": { cardinality: "variable", dynamicFields: true },
};

/** Derives output field names from Aggregate node parameters */
function aggregateOutputFields(params: Record<string, unknown>): string[] {
  const destField =
    typeof params.destinationFieldName === "string" && params.destinationFieldName !== ""
      ? params.destinationFieldName
      : "data";
  return [destField];
}

/**
 * Parameter schema overrides.
 *
 * nodes.json has complex displayOptions conditions that don't map cleanly
 * to our simple condition model. For nodes with test-validated behavior,
 * overrides REPLACE the generated schemas entirely rather than merging.
 *
 * This preserves backward compatibility for curated nodes while still
 * benefiting from auto-generated schemas for the hundreds of other nodes.
 */
export const paramSchemaOverrides: Record<string, NodeTypeSchema[]> = {
  "n8n-nodes-base.code": [
    {
      nodeType: "n8n-nodes-base.code",
      params: { jsCode: { required: true, type: "string" } },
    },
  ],
  "n8n-nodes-base.slack": [
    {
      nodeType: "n8n-nodes-base.slack",
      requiresCredentials: true,
      conditionParam: "resource",
      conditionValue: "",
      params: {
        channelId: {
          required: true,
          type: "object",
          nestedRequired: ["value"],
        },
      },
    },
    {
      nodeType: "n8n-nodes-base.slack",
      requiresCredentials: true,
      conditionParam: "resource",
      conditionValue: "file",
    },
  ],
  "n8n-nodes-base.executeWorkflow": [
    {
      nodeType: "n8n-nodes-base.executeWorkflow",
      params: {
        workflowId: {
          required: true,
          type: "object",
          nestedRequired: ["value"],
        },
      },
    },
  ],
  "@n8n/n8n-nodes-langchain.agent": [
    {
      nodeType: "@n8n/n8n-nodes-langchain.agent",
      params: {
        promptType: { required: true, type: "string" },
        text: { required: true, type: "string" },
      },
    },
  ],
  "n8n-nodes-base.scheduleTrigger": [
    {
      nodeType: "n8n-nodes-base.scheduleTrigger",
      params: { rule: { required: true, type: "object" } },
    },
  ],
  "n8n-nodes-base.googleBigQuery": [
    {
      nodeType: "n8n-nodes-base.googleBigQuery",
      requiresCredentials: true,
      params: {
        projectId: {
          required: true,
          type: "object",
          nestedRequired: ["value"],
        },
      },
    },
  ],
  "n8n-nodes-base.httpRequest": [
    {
      nodeType: "n8n-nodes-base.httpRequest",
      params: {
        url: { required: true, type: "string" },
        method: {
          type: "string",
          allowedValues: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        },
      },
    },
  ],
  "n8n-nodes-base.webhook": [
    {
      nodeType: "n8n-nodes-base.webhook",
      params: {
        path: { required: true, type: "string" },
        httpMethod: {
          type: "string",
          allowedValues: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        },
      },
    },
  ],
  "n8n-nodes-base.filter": [
    {
      nodeType: "n8n-nodes-base.filter",
      params: { conditions: { required: true, type: "object" } },
    },
  ],
  "n8n-nodes-base.if": [
    {
      nodeType: "n8n-nodes-base.if",
      params: { conditions: { required: true, type: "object" } },
    },
  ],
  "n8n-nodes-base.set": [
    {
      nodeType: "n8n-nodes-base.set",
      minVersion: 3.0,
      params: { assignments: { required: true, type: "object" } },
    },
  ],
  "n8n-nodes-base.notion": [
    {
      nodeType: "n8n-nodes-base.notion",
      requiresCredentials: true,
      params: { resource: { required: true, type: "string" } },
    },
  ],
  "n8n-nodes-base.splitInBatches": [
    {
      nodeType: "n8n-nodes-base.splitInBatches",
      params: { batchSize: { type: "number" } },
    },
  ],
  "@n8n/n8n-nodes-langchain.lmChatGoogleVertex": [
    {
      nodeType: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
      requiresCredentials: true,
      params: {
        modelName: { required: true, type: "string" },
        projectId: {
          required: true,
          type: "object",
          nestedRequired: ["value"],
        },
      },
    },
  ],
  "@n8n/n8n-nodes-langchain.outputParserStructured": [
    {
      nodeType: "@n8n/n8n-nodes-langchain.outputParserStructured",
      params: { inputSchema: { required: true, type: "string" } },
    },
  ],
};
