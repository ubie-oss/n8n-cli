import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NodeDescription } from "./node-schema-types.ts";

// n8n property types that are UI-only / non-data
const UI_ONLY_TYPES = new Set([
  "notice",
  "callout",
  "button",
  "curlImport",
  "hidden",
  "credentials",
]);

interface RawNodeProperty {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ name?: string; value: string | number | boolean }>;
  displayOptions?: {
    show?: Record<string, Array<string | number | boolean>>;
    hide?: Record<string, Array<string | number | boolean>>;
  };
}

interface RawNodeDescription {
  name: string;
  displayName?: string;
  description?: string;
  version: number | number[];
  group?: string[];
  inputs?: string[];
  outputs?: string[];
  usableAsTool?: boolean;
  credentials?: Array<{ name: string; required?: boolean }>;
  properties: RawNodeProperty[];
}

const PACKAGES = [
  { path: "node_modules/n8n-nodes-base/dist/types/nodes.json", prefix: "n8n-nodes-base" },
  {
    path: "node_modules/@n8n/n8n-nodes-langchain/dist/types/nodes.json",
    prefix: "@n8n/n8n-nodes-langchain",
  },
];

function normalizeVersions(version: number | number[]): number[] {
  return Array.isArray(version) ? version : [version];
}

function convertNode(raw: RawNodeDescription, prefix: string): NodeDescription {
  const properties = raw.properties
    .filter((p) => !UI_ONLY_TYPES.has(p.type))
    .map((p) => {
      const prop: NodeDescription["properties"][number] = {
        name: p.name,
        type: p.type,
      };
      if (p.description) prop.description = p.description;
      if (p.required === true) prop.required = true;
      if (p.default !== undefined) prop.default = p.default;
      if (p.options && p.options.length > 0) {
        prop.options = p.options.map((o) => ({ name: o.name ?? String(o.value), value: o.value }));
      }
      if (p.displayOptions) prop.displayOptions = p.displayOptions;
      return prop;
    });

  const result: NodeDescription = {
    nodeType: `${prefix}.${raw.name}`,
    displayName: raw.displayName ?? raw.name,
    description: raw.description ?? "",
    versions: normalizeVersions(raw.version),
    group: raw.group ?? [],
    inputs: raw.inputs ?? ["main"],
    outputs: raw.outputs ?? ["main"],
    properties,
  };

  if (raw.usableAsTool) result.usableAsTool = true;
  if (raw.credentials && raw.credentials.length > 0) {
    result.credentials = raw.credentials.map((c) => {
      const entry: { name: string; required?: boolean } = { name: c.name };
      if (c.required) entry.required = true;
      return entry;
    });
  }

  return result;
}

export async function loadNodeDescriptions(): Promise<NodeDescription[]> {
  const descriptions: NodeDescription[] = [];

  for (const pkg of PACKAGES) {
    const fullPath = resolve(pkg.path);
    if (!existsSync(fullPath)) {
      console.error(`Warning: ${fullPath} not found, skipping`);
      continue;
    }
    const rawNodes: RawNodeDescription[] = await Bun.file(fullPath).json();
    for (const raw of rawNodes) {
      descriptions.push(convertNode(raw, pkg.prefix));
    }
  }

  return descriptions;
}
