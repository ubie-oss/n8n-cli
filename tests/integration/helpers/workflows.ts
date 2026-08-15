import type { Node, Workflow } from "@/api/types.ts";

const TRIGGER: Node = {
  id: "n-trigger",
  name: "Start",
  type: "n8n-nodes-base.manualTrigger",
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

const SET: Node = {
  id: "n-set",
  name: "Set",
  type: "n8n-nodes-base.set",
  typeVersion: 3,
  position: [220, 0],
  parameters: { assignments: { assignments: [] } },
};

const CONNECTED = {
  Start: {
    main: [[{ node: "Set", type: "main", index: 0 }]],
  },
};

/** A workflow that passes the default error-level lint rules. */
export function cleanWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "Clean Workflow",
    active: false,
    nodes: [TRIGGER, SET],
    connections: CONNECTED,
    ...overrides,
  };
}

/**
 * Valid enough for `workflow create` input checks (name/nodes/connections
 * present) but fails `connection-reference` — the case the proxy exists for:
 * a client that skipped its own lint still cannot write through the gate.
 */
export function brokenWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "Broken Workflow",
    active: false,
    nodes: [TRIGGER],
    connections: {
      Start: {
        main: [[{ node: "MissingNode", type: "main", index: 0 }]],
      },
    },
    ...overrides,
  };
}
