import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGES = [
  { path: "node_modules/n8n-nodes-base/dist/types/nodes.json", prefix: "n8n-nodes-base" },
  {
    path: "node_modules/@n8n/n8n-nodes-langchain/dist/types/nodes.json",
    prefix: "@n8n/n8n-nodes-langchain",
  },
];

interface RawNodeEntry {
  name: string;
  version: number | number[];
  properties: unknown[];
}

interface CachedNode {
  versions: number[];
  properties: unknown[];
}

/** Module-level cache: nodeType → CachedNode[] (multiple entries for same nodeType with different versions) */
let propertiesIndex: Map<string, CachedNode[]> | null = null;

function buildIndex(): Map<string, CachedNode[]> {
  const index = new Map<string, CachedNode[]>();
  for (const pkg of PACKAGES) {
    const fullPath = resolve(pkg.path);
    if (!existsSync(fullPath)) continue;
    const rawNodes: RawNodeEntry[] = JSON.parse(readFileSync(fullPath, "utf-8"));
    for (const raw of rawNodes) {
      const nodeType = `${pkg.prefix}.${raw.name}`;
      const versions = Array.isArray(raw.version) ? raw.version : [raw.version];
      const entries = index.get(nodeType) ?? [];
      entries.push({ versions, properties: raw.properties });
      index.set(nodeType, entries);
    }
  }
  return index;
}

/** Returns raw properties for a given node type and version, or null if not found */
export function lookupRawProperties(nodeType: string, typeVersion: number): unknown[] | null {
  if (!propertiesIndex) {
    propertiesIndex = buildIndex();
  }
  const entries = propertiesIndex.get(nodeType);
  if (!entries) return null;
  for (const entry of entries) {
    if (entry.versions.includes(typeVersion)) return entry.properties;
  }
  return null;
}
