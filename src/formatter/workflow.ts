import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadYamlWorkflow } from "@/yaml/loader.ts";

/** Constants for layout calculation */
export const GRID_SIZE = 20.0;
export const RANK_SEP = 200.0;
export const NODE_SEP = 80.0;
export const SUBGRAPH_GAP = 300.0;
export const DEFAULT_NODE_WIDTH = 200.0;
export const DEFAULT_NODE_HEIGHT = 80.0;
export const STICKY_NOTE_TYPE = "n8n-nodes-base.stickyNote";

/** Error types */
export const ErrInvalidJSON = new Error("invalid JSON format");
export const ErrMissingNodes = new Error("nodes array not found");
export const ErrEmptyWorkflow = new Error("workflow has no nodes");

/** FormatterNode represents a single node in an n8n workflow (formatter-specific) */
export interface FormatterNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

/** FormatterWorkflow represents an n8n workflow (formatter-specific) */
export interface FormatterWorkflow {
  id?: string;
  name: string;
  active: boolean;
  nodes: FormatterNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** LoadWorkflow loads a workflow from a JSON file */
export function loadWorkflow(filePath: string): FormatterWorkflow {
  const data = readFileSync(filePath, "utf-8");

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (e) {
    throw new Error(`${ErrInvalidJSON.message}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw ErrInvalidJSON;
  }

  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) {
    throw ErrMissingNodes;
  }
  if (nodes.length === 0) {
    throw ErrEmptyWorkflow;
  }

  return raw as unknown as FormatterWorkflow;
}

/** SaveWorkflow saves a workflow to a JSON or YAML file with deterministic output */
export function saveWorkflow(filePath: string, workflow: FormatterWorkflow): void {
  const ext = path.extname(filePath).toLowerCase();
  const data =
    ext === ".yaml" || ext === ".yml"
      ? serializeDeterministicYaml(workflow)
      : serializeDeterministic(workflow);
  writeFileSync(filePath, data, "utf-8");
}

/** LoadWorkflowAsync loads a workflow from JSON or YAML file */
export async function loadWorkflowAsync(filePath: string): Promise<FormatterWorkflow> {
  const ext = path.extname(filePath).toLowerCase();

  let raw: unknown;

  if (ext === ".yaml" || ext === ".yml") {
    raw = loadYamlWorkflow(filePath);
  } else {
    return loadWorkflow(filePath);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw ErrInvalidJSON;
  }

  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) {
    throw ErrMissingNodes;
  }
  if (nodes.length === 0) {
    throw ErrEmptyWorkflow;
  }

  return raw as unknown as FormatterWorkflow;
}

/** IsStickyNote checks if a node is a sticky note */
export function isStickyNote(node: FormatterNode): boolean {
  return node.type === STICKY_NOTE_TYPE;
}

/** SnapToGrid snaps a coordinate to the nearest grid point */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/** Recursively sorts object keys in alphabetical order */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

/** Produces deterministic JSON: nodes sorted by position, keys sorted alphabetically */
export function serializeDeterministic(workflow: FormatterWorkflow): string {
  const sorted = {
    ...workflow,
    nodes: [...workflow.nodes].sort((a, b) => {
      if (a.position[0] !== b.position[0]) return a.position[0] - b.position[0];
      return a.position[1] - b.position[1];
    }),
  };
  return JSON.stringify(sortKeys(sorted), null, 2);
}

/** Produces deterministic YAML: nodes sorted by position, keys sorted alphabetically */
export function serializeDeterministicYaml(workflow: FormatterWorkflow): string {
  const sorted = {
    ...workflow,
    nodes: [...workflow.nodes].sort((a, b) => {
      if (a.position[0] !== b.position[0]) return a.position[0] - b.position[0];
      return a.position[1] - b.position[1];
    }),
  };
  return yaml.dump(sortKeys(sorted), {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  });
}
