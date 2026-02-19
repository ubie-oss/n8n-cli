import fs from "node:fs";
import path from "node:path";
import { isAlreadyOwnedError, isNotFoundError } from "../api/errors.ts";
import type { TagService } from "../api/tag-service.ts";
import type { Workflow, WorkflowInput } from "../api/types.ts";
import type { WorkflowService } from "../api/workflow-service.ts";
import { ContentRetriever, ErrFileNotExist } from "../git/content.ts";
import { compare } from "./differ.ts";
import { DuplicateChecker } from "./duplicate.ts";
import { Scanner } from "./scanner.ts";
import { TagMerger } from "./tags.ts";
import { ThreeWayDetector } from "./threeway/detector.ts";
import { type DiffSpec, parseDiffSpec } from "./threeway/diffspec.ts";
import type {
  ApplyOperation,
  ApplyOptions,
  ApplyResult,
  OperationType,
  WorkflowFile,
} from "./types.ts";
import { defaultOperation, emptyResult, updateCounts } from "./types.ts";

/** ProgressCallback is called during execution to report progress. */
export type ProgressCallback = (
  current: number,
  total: number,
  filename: string,
  operation: OperationType,
) => void;

/** Executor handles the apply operation logic. */
export class Executor {
  private tagMerger?: TagMerger;
  private duplicateChecker?: DuplicateChecker;
  private scanner = new Scanner();
  private onProgress?: ProgressCallback;
  private threeWayDetector?: ThreeWayDetector;
  private gitContent?: ContentRetriever;
  private diffSpec?: DiffSpec;

  constructor(
    private readonly workflowService: WorkflowService,
    private readonly opts: ApplyOptions,
  ) {
    // Initialize 3-way detection if --from-git-changes is specified
    if (opts.fromGitChanges && opts.gitDiffSpec) {
      try {
        this.diffSpec = parseDiffSpec(opts.gitDiffSpec);
        this.threeWayDetector = new ThreeWayDetector();
        this.gitContent = new ContentRetriever();
      } catch {
        // Silently fall back to 2-way detection
      }
    }
  }

  setTagService(tagService: TagService): void {
    this.tagMerger = new TagMerger(tagService);
  }

  setProgressCallback(cb: ProgressCallback): void {
    this.onProgress = cb;
  }

  private isThreeWayEnabled(): boolean {
    return !!(this.threeWayDetector && this.gitContent && this.diffSpec);
  }

  /**
   * Retrieves the workflow state at the base ref using git show.
   * Returns null if the file didn't exist at base ref (new file).
   * Throws on other errors (caller should fallback to 2-way).
   */
  private async getBaseWorkflow(filePath: string): Promise<Workflow | null> {
    if (!this.isThreeWayEnabled()) {
      throw new Error("3-way detection not enabled");
    }

    // Skip YAML files - they cannot be reliably retrieved via git show
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      throw new Error(`${ext} files not supported for 3-way detection`);
    }

    // Get relative path from git repository root
    let relPath = filePath;
    if (path.isAbsolute(filePath)) {
      try {
        const gitRoot = await this.gitContent!.getRepoRoot();
        relPath = path.relative(gitRoot, filePath);
      } catch {
        // Use original path
      }
    }

    try {
      const content = await this.gitContent!.getFileAtRef(this.diffSpec!.baseRef, relPath);
      return JSON.parse(content) as Workflow;
    } catch (err) {
      if (err === ErrFileNotExist) {
        return null; // New file
      }
      throw err;
    }
  }

  /** Execute runs the apply operation and returns the result. */
  async execute(): Promise<ApplyResult> {
    const result = emptyResult(this.opts.dryRun);

    // Initialize duplicate checker if warnings are enabled
    if (this.opts.warnDuplicates) {
      this.duplicateChecker = new DuplicateChecker(this.workflowService);
      await this.duplicateChecker.loadRemoteWorkflows();
    }

    // Scan workflow files
    const files = await this.scanner.scanWithOptions(this.opts);
    if (files.length === 0) return result;

    // Process each workflow file
    const total = files.length;
    for (let i = 0; i < files.length; i++) {
      const op = await this.processWorkflowFile(files[i]!, result);
      result.operations.push(op);

      if (this.onProgress && !this.opts.dryRun) {
        this.onProgress(i + 1, total, files[i]!.path, op.operation);
      }
    }

    updateCounts(result);
    result.warningCount = result.warnings.length;
    return result;
  }

  /** Processes a single workflow file and returns the operation. */
  private async processWorkflowFile(
    wf: WorkflowFile,
    result: ApplyResult,
  ): Promise<ApplyOperation> {
    const op = defaultOperation(wf.path);

    // Check for parse errors
    if (wf.error) {
      op.operation = "error";
      op.error = wf.error;
      return op;
    }

    const workflow = wf.workflow!;
    op.workflowName = workflow.name;
    op.localUpdated = workflow.updatedAt;

    // No ID = create
    if (!workflow.id) {
      op.operation = "create";

      // Check for duplicates if enabled
      if (this.duplicateChecker && workflow.name) {
        const warnings = this.duplicateChecker.findDuplicatesByName(wf.path, workflow.name);
        result.warnings.push(...warnings);
      }

      if (!this.opts.dryRun) {
        try {
          await this.executeCreate(wf, op);
        } catch (err) {
          op.operation = "error";
          op.error = err instanceof Error ? err : new Error(String(err));
        }
      }
      return op;
    }

    op.workflowID = workflow.id;

    // Fetch remote workflow
    let remoteWorkflow: Workflow;
    try {
      remoteWorkflow = await this.workflowService.getWorkflow(workflow.id);
    } catch (err) {
      if (isNotFoundError(err)) {
        // ID exists but not found on remote = create
        op.operation = "create";
        if (!this.opts.dryRun) {
          try {
            await this.executeCreate(wf, op);
          } catch (createErr) {
            op.operation = "error";
            op.error = createErr instanceof Error ? createErr : new Error(String(createErr));
          }
        }
        return op;
      }
      op.operation = "error";
      op.error = err instanceof Error ? err : new Error(String(err));
      return op;
    }

    op.remoteUpdated = remoteWorkflow.updatedAt;

    // Compare workflows
    const diff = compare(workflow, remoteWorkflow);
    op.diff = diff;

    // Try 3-way conflict detection if enabled
    if (this.isThreeWayEnabled()) {
      try {
        const baseWorkflow = await this.getBaseWorkflow(wf.path);
        const threeWayResult = this.threeWayDetector!.detect(
          baseWorkflow,
          workflow,
          remoteWorkflow,
        );

        op.threeWayUsed = true;
        op.threeWayReason = threeWayResult.reason;
        if (threeWayResult.baseToLocal) {
          op.baseToLocalFields = threeWayResult.baseToLocal.changedFields;
        }
        if (threeWayResult.baseToRemote) {
          op.baseToRemoteFields = threeWayResult.baseToRemote.changedFields;
        }

        switch (threeWayResult.type) {
          case "create":
            // base is nil but remote exists - fallback to 2-way
            if (remoteWorkflow) {
              op.threeWayUsed = false;
              op.threeWayReason = "fallback: base missing but remote exists";
              break; // fall through to 2-way
            }
            op.operation = "create";
            if (!this.opts.dryRun) {
              try {
                await this.executeCreate(wf, op);
              } catch (err) {
                op.operation = "error";
                op.error = err instanceof Error ? err : new Error(String(err));
              }
            }
            return op;

          case "skip":
            op.operation = "skip";
            return op;

          case "update":
            op.operation = "update";
            if (!this.opts.dryRun) {
              try {
                await this.executeUpdate(wf, remoteWorkflow, op);
              } catch (err) {
                op.operation = "error";
                op.error = err instanceof Error ? err : new Error(String(err));
              }
            }
            return op;

          case "conflict":
            if (this.opts.force) {
              op.forced = true;
              op.operation = "update";
              if (!this.opts.dryRun) {
                try {
                  await this.executeUpdate(wf, remoteWorkflow, op);
                } catch (err) {
                  op.operation = "error";
                  op.error = err instanceof Error ? err : new Error(String(err));
                }
              }
              return op;
            }
            op.operation = "conflict";
            return op;

          case "fallback":
            op.threeWayUsed = false;
            break; // fall through to 2-way
        }
      } catch {
        // Error retrieving base - fallback to 2-way
        op.threeWayUsed = false;
      }
    }

    // 2-way conflict detection (fallback or when 3-way is not available)
    if (op.localUpdated && op.remoteUpdated) {
      const localDate = new Date(op.localUpdated);
      const remoteDate = new Date(op.remoteUpdated);
      if (remoteDate > localDate) {
        if (diff.hasChanges) {
          // Content differs and remote is newer - real conflict
          if (this.opts.force) {
            op.forced = true;
          } else {
            op.operation = "conflict";
            return op;
          }
        } else {
          // Content is the same - local has no real changes, skip
          op.operation = "skip";
          return op;
        }
      }
    }

    if (!diff.hasChanges) {
      op.operation = "skip";
      return op;
    }

    op.operation = "update";

    if (!this.opts.dryRun) {
      try {
        await this.executeUpdate(wf, remoteWorkflow, op);
      } catch (err) {
        op.operation = "error";
        op.error = err instanceof Error ? err : new Error(String(err));
      }
    }

    return op;
  }

  /** Performs the actual create operation. */
  private async executeCreate(wf: WorkflowFile, op: ApplyOperation): Promise<void> {
    const workflow = wf.workflow!;
    const input: WorkflowInput = {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings,
      staticData: workflow.staticData,
    };

    const created = await this.workflowService.createWorkflow(input);
    await this.applyTagsAndProject(created, workflow, op);
    await updateLocalWorkflowFile(wf.path, created);
  }

  /** Performs the actual update operation. */
  private async executeUpdate(
    wf: WorkflowFile,
    _remote: Workflow,
    op: ApplyOperation,
  ): Promise<void> {
    const workflow = wf.workflow!;
    // Note: pinData is intentionally excluded - n8n API rejects it as additional property
    const input: WorkflowInput = {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings,
      staticData: workflow.staticData,
    };

    const updated = await this.workflowService.updateWorkflow(workflow.id!, input);
    await this.applyTagsAndProject(updated, workflow, op);
    await updateLocalWorkflowFile(wf.path, updated);
  }

  /** Applies tags and transfers workflow to target project. */
  private async applyTagsAndProject(
    workflow: Workflow,
    localWorkflow: Workflow,
    op: ApplyOperation,
  ): Promise<void> {
    // Handle tags
    if (this.tagMerger && !this.opts.noAutoTag) {
      const result = await this.tagMerger.mergeTags(
        localWorkflow.tags,
        workflow.tags,
        this.opts.autoTags,
      );
      if (result.added.length > 0) {
        await this.tagMerger.applyTags(workflow.id!, result.allTags);
        op.tagsAdded = result.added;
      }
    }

    // Handle project transfer
    if (this.opts.projectID) {
      const currentProjectID = this.workflowService.getWorkflowCurrentProjectID(workflow);
      if (currentProjectID !== this.opts.projectID) {
        try {
          await this.workflowService.transferWorkflow(workflow.id!, this.opts.projectID);
          op.projectMoved = true;
          op.fromProject = currentProjectID;
          op.toProject = this.opts.projectID;
        } catch (err) {
          if (!isAlreadyOwnedError(err)) {
            throw err;
          }
          // Already in target project - no state change needed
        }
      }
    }

    // Handle activation/deactivation
    await this.applyActivation(localWorkflow, op);
  }

  /** Applies activation or deactivation based on local workflow definition. */
  private async applyActivation(workflow: Workflow, op: ApplyOperation): Promise<void> {
    const localActive = workflow.active;

    // Get remote active state from diff
    const remoteDiff = op.diff?.fields.find((f) => f.field === "active");
    if (!remoteDiff) {
      // No change in active field - nothing to do
      return;
    }

    const remoteActive = remoteDiff.oldValue as boolean;

    if (localActive === remoteActive) {
      // Already in desired state - nothing to do
      return;
    }

    try {
      if (localActive) {
        // Local is true, remote is false - activate
        await this.workflowService.activateWorkflow(workflow.id!);
        op.activated = true;
      } else {
        // Local is false, remote is true - deactivate
        await this.workflowService.deactivateWorkflow(workflow.id!);
        op.activated = false;
      }
    } catch (err) {
      op.activationError = err instanceof Error ? err : new Error(String(err));
      // Don't throw - activation failure is not a workflow update failure
    }
  }
}

/** Updates the local workflow file with server response data. */
async function updateLocalWorkflowFile(filePath: string, workflow: Workflow): Promise<void> {
  // Skip non-JSON files
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".json") return;

  let data: string;
  try {
    data = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(data);
  } catch {
    return;
  }

  existing.id = workflow.id;
  existing.name = workflow.name;
  existing.active = workflow.active;
  if (workflow.updatedAt) existing.updatedAt = workflow.updatedAt;
  if (workflow.createdAt) existing.createdAt = workflow.createdAt;

  const output = JSON.stringify(existing, null, 2);
  fs.writeFileSync(filePath, `${output}\n`);
}
