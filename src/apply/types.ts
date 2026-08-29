import type { Workflow } from "../api/types.ts";
import type { WorkflowDiffDetail } from "../diff/model.ts";
import type { Violation } from "../lint/rules/violation.ts";

/** OperationType represents the type of operation to perform on a workflow. */
export type OperationType = "create" | "update" | "skip" | "conflict" | "error";

/** SourceType indicates the format of the source file. */
export type SourceType = "json" | "yaml" | "ts";

/** ApplyOptions holds configuration for the apply command. */
export interface ApplyOptions {
  directory: string;
  all: boolean;
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
  /**
   * When true, `.ts` workflow files written against `@n8n/workflow-sdk` are
   * scanned alongside JSON and YAML. Off by default so that unrelated
   * TypeScript in a definitions directory is never parsed as a workflow.
   */
  tsEnabled: boolean;
  /** Forces `.ts` scanning off even when enabled elsewhere. */
  noTs: boolean;
  /**
   * When true, skip the upstream duplicate-name check.
   *
   * Default false (check ON): on every apply we list the upstream workflows
   * and surface a warning if a local workflow would create a remotely-existing
   * name. The warning causes a non-zero exit unless `--force` is also passed.
   * Set true to disable the check entirely.
   */
  allowDuplicates: boolean;
  /**
   * When true, skip the pre-write lint check that runs against every local
   * workflow before it is created or updated upstream.
   *
   * Default false (check ON): the same rule set used by `n8n-cli lint` runs
   * against each workflow about to be written. Any `error`-severity violation
   * marks that workflow as failed and prevents the API call — the apply
   * continues with the remaining workflows so a partial run still reports
   * everything in one pass. Set true to disable the check entirely; this
   * cannot be silenced by `--force` because lint failures represent policy,
   * not merge conflicts.
   */
  noLint: boolean;
  /** Optional override for the lint config path (auto-discovered when empty). */
  lintConfigPath?: string;
  /** Rule names disabled via CLI flag, forwarded to the lint registry. */
  lintDisableRules: string[];
  filterByTags: string[];
  /**
   * Ordered list of server-middleware names to run before writing each
   * workflow upstream. Defaults to ["lint"] when empty for legacy
   * compatibility. Set via --server-middleware or N8N_SERVER_MIDDLEWARES.
   */
  middlewares: string[];
  /**
   * Flat commander-style options bag forwarded to each server-middleware
   * factory. Populated by `cli/commands/apply.ts` so each middleware can
   * pick out its own keys (e.g. authzGroupsUrl).
   */
  middlewareCliOptions: Record<string, unknown>;
  /**
   * When true (default), folder declarations are honoured: `folders.yaml` in
   * the definitions directory is synced first, and each workflow's `folder:`
   * / `parentFolderId` declaration is applied after the workflow write.
   * Disable with --no-folders.
   */
  foldersEnabled: boolean;
  /**
   * When true (default), a folder path in a definition that does not exist
   * upstream is created. With --no-create-missing-folders an unresolvable
   * path is an error (or a warning, unless --strict-folders).
   */
  createMissingFolders: boolean;
  /**
   * When true, folder problems (license missing, unresolvable path, failed
   * move) fail the workflow's apply instead of degrading to a warning.
   */
  strictFolders: boolean;
}

/** Returns ApplyOptions with default values. */
export function defaultApplyOptions(): ApplyOptions {
  return {
    directory: "./definitions",
    all: false,
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
    tsEnabled: false,
    noTs: false,
    allowDuplicates: false,
    noLint: false,
    lintDisableRules: [],
    filterByTags: [],
    middlewares: [],
    middlewareCliOptions: {},
    foldersEnabled: true,
    createMissingFolders: true,
    strictFolders: false,
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
  /**
   * Node- and edge-level detail for update operations, computed when the
   * coarse `diff` reports changes. Direction is remote (old) → local (new):
   * what this apply would change on the server. Purely presentational —
   * conflict detection never reads it.
   */
  detailDiff?: WorkflowDiffDetail;
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
  /** True when the workflow's folder assignment was applied (or planned, in dry-run). */
  folderApplied?: boolean;
  /** Resolved target folder path (null = project root); for reporting. */
  folderPath?: string | null;
  /** Folder segments this apply created to make the path resolvable. */
  folderCreated?: string[];
  /** Non-fatal folder failure (license missing, unresolvable path, move error). */
  folderWarning?: string;
  /**
   * Violations surfaced by the pre-write lint check, when one ran. Present on
   * both blocked (operation === "error") and passing operations so callers
   * can surface warnings without forcing a re-lint.
   *
   * Kept for backwards compatibility with existing reporters; for non-lint
   * middlewares see `middlewareViolations` below.
   */
  lintViolations?: Violation[];
  /**
   * Violations surfaced by any middleware in the pipeline (including lint).
   * Set in addition to `lintViolations` so existing consumers continue to
   * work unchanged.
   */
  middlewareViolations?: Violation[];
  /** Name of the middleware that blocked this operation, if any. */
  blockedByMiddleware?: string;
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
  /** Folder paths created by the folders.yaml sync (Phase 0), in order. */
  foldersCreated: Array<{ projectId: string; path: string }>;
  /** How many folder paths the sync found already in place. */
  foldersExisting: number;
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
    foldersCreated: [],
    foldersExisting: 0,
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
