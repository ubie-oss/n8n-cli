import type { Workflow } from "../api/types.ts";

/** OperationType represents the type of operation to perform on a workflow. */
export type OperationType = "create" | "update" | "skip" | "conflict" | "error";

/** SourceType indicates the format of the source file. */
export type SourceType = "json" | "yaml";

/** ApplyOptions holds configuration for the apply command. */
export interface ApplyOptions {
  directory: string;
  dryRun: boolean;
  force: boolean;
  projectID: string;
  autoTags: string[];
  noAutoTag: boolean;
  ids: string[];
  fromGitChanges: boolean;
  gitDiffSpec: string;
  yamlEnabled: boolean;
  noYaml: boolean;
  warnDuplicates: boolean;
  filterByTags: string[];
}

/** Returns ApplyOptions with default values. */
export function defaultApplyOptions(): ApplyOptions {
  return {
    directory: "./definitions",
    dryRun: false,
    force: false,
    projectID: "",
    autoTags: [],
    noAutoTag: false,
    ids: [],
    fromGitChanges: false,
    gitDiffSpec: "",
    yamlEnabled: false,
    noYaml: false,
    warnDuplicates: false,
    filterByTags: [],
  };
}

/** FieldDiff represents the difference in a single field between local and remote. */
export interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** WorkflowDiff represents differences between local and remote workflow definitions. */
export interface WorkflowDiff {
  hasChanges: boolean;
  fields: FieldDiff[];
}

/** ApplyOperation represents a planned or executed operation on a single workflow. */
export interface ApplyOperation {
  file: string;
  operation: OperationType;
  workflowID: string;
  workflowName: string;
  localUpdated?: string;
  remoteUpdated?: string;
  diff?: WorkflowDiff;
  error?: Error;
  forced: boolean;
  tagsAdded: string[];
  projectMoved: boolean;
  fromProject: string;
  toProject: string;
  threeWayUsed: boolean;
  threeWayReason: string;
  baseToLocalFields: string[];
  baseToRemoteFields: string[];
  activated?: boolean; // true: activated, false: deactivated, undefined: no change
  activationError?: Error; // activation/deactivation error
}

/** Creates a default ApplyOperation. */
export function defaultOperation(file: string): ApplyOperation {
  return {
    file,
    operation: "error",
    workflowID: "",
    workflowName: "",
    forced: false,
    tagsAdded: [],
    projectMoved: false,
    fromProject: "",
    toProject: "",
    threeWayUsed: false,
    threeWayReason: "",
    baseToLocalFields: [],
    baseToRemoteFields: [],
    activated: undefined,
    activationError: undefined,
  };
}

/** DuplicateWarning represents a warning about a potential duplicate workflow. */
export interface DuplicateWarning {
  localPath: string;
  localName: string;
  remoteID: string;
  remoteName: string;
  remoteActive: boolean;
}

/** ApplyResult holds the aggregated result of an apply operation across all files. */
export interface ApplyResult {
  operations: ApplyOperation[];
  dryRun: boolean;
  warnings: DuplicateWarning[];
  createCount: number;
  updateCount: number;
  skipCount: number;
  conflictCount: number;
  errorCount: number;
  warningCount: number;
}

/** Creates an empty ApplyResult. */
export function emptyResult(dryRun: boolean): ApplyResult {
  return {
    operations: [],
    dryRun,
    warnings: [],
    createCount: 0,
    updateCount: 0,
    skipCount: 0,
    conflictCount: 0,
    errorCount: 0,
    warningCount: 0,
  };
}

/** Recalculates summary counts from operations. */
export function updateCounts(result: ApplyResult): void {
  result.createCount = 0;
  result.updateCount = 0;
  result.skipCount = 0;
  result.conflictCount = 0;
  result.errorCount = 0;
  for (const op of result.operations) {
    switch (op.operation) {
      case "create":
        result.createCount++;
        break;
      case "update":
        result.updateCount++;
        break;
      case "skip":
        result.skipCount++;
        break;
      case "conflict":
        result.conflictCount++;
        break;
      case "error":
        result.errorCount++;
        break;
    }
  }
}

/** WorkflowFile represents a workflow file in the definitions directory. */
export interface WorkflowFile {
  path: string;
  sourceType: SourceType;
  workflow?: Workflow;
  error?: Error;
}
