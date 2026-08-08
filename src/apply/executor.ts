import fs from "node:fs";
import path from "node:path";
import { isAlreadyOwnedError, isNotFoundError } from "../api/errors.ts";
import type { TagService } from "../api/tag-service.ts";
import type { Workflow, WorkflowInput } from "../api/types.ts";
import type { WorkflowService } from "../api/workflow-service.ts";
import { ContentRetriever, ErrFileNotExist } from "../git/content.ts";
import type { Violation } from "../lint/rules/violation.ts";
import { formatViolationLine } from "../lint/write-check.ts";
import { disposePipeline, preparePipeline, runPipeline } from "../middleware/pipeline.ts";
import { buildMiddlewares, resolveEnabledList } from "../middleware/registry.ts";
import type { ServerMiddleware } from "../middleware/types.ts";
import { DEFAULT_SERVER_MIDDLEWARE_CHAIN, registerBuiltins } from "../middleware/wiring.ts";
import { compare } from "./differ.ts";
import { DuplicateChecker } from "./duplicate.ts";
import { updateLocalWorkflowFile } from "./local-file.ts";
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
  private middlewares: ServerMiddleware[] = [];
  private preparedNames = new Set<string>();

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

    // Build the server-middleware pipeline. Default chain is ["lint"] for
    // legacy compatibility; users opt-in to authz (or future policies) via
    // --server-middleware or N8N_SERVER_MIDDLEWARES.
    //
    // `--no-lint` is honored by *removing* lint from the chain rather than
    // by passing enforce=off, so users keep getting backwards-compatible
    // behavior even when they enable authz alongside.
    //
    // `LintConfigLoadError` is intentionally NOT caught here — it would leave
    // the user with a half-initialised Executor. The caller in
    // `src/cli/commands/apply.ts` is responsible for catching the typed error
    // and printing a friendly message.
    registerBuiltins();
    const enabled = resolveEnabledList({
      cliValue: opts.middlewares.join(","),
      env: process.env,
      envVar: "N8N_SERVER_MIDDLEWARES",
      fallback: DEFAULT_SERVER_MIDDLEWARE_CHAIN,
    });
    const filtered = opts.noLint ? enabled.filter((n) => n !== "lint") : enabled;

    // Stitch legacy lint flags into the CLI options bag the lint factory
    // expects. Keeps `--lint-config` / `--lint-disable-rule` working.
    const legacyCliOpts: Record<string, unknown> = {
      ...(opts.lintConfigPath ? { lintConfig: opts.lintConfigPath } : {}),
      ...(opts.lintDisableRules.length ? { lintDisableRule: opts.lintDisableRules } : {}),
      lintStartDir: opts.directory,
      ...opts.middlewareCliOptions,
    };
    this.middlewares = buildMiddlewares({
      enabled: filtered,
      env: process.env,
      cliOpts: legacyCliOpts,
    });

    // Eagerly run prepare() on every middleware whose prepare() is
    // synchronous (currently lint, which reads .n8nlintrc.json from disk).
    // This restores the legacy behavior where a malformed lint config
    // throws `LintConfigLoadError` from `new Executor(...)`, letting the
    // friendly error handler in `src/cli/commands/apply.ts` (which wraps
    // only the constructor call) fire and print the bypass hint.
    //
    // Middlewares with async prepare() (e.g. future HTTP-fetching policies)
    // remain deferred to execute()'s `preparePipeline` call. The
    // synchronously-prepared set is tracked so execute() does not call
    // prepare() on them a second time.
    for (const mw of this.middlewares) {
      const fn = mw.prepare;
      if (!fn) {
        this.preparedNames.add(mw.name);
        continue;
      }
      const result = fn.call(mw);
      if (result === undefined) {
        this.preparedNames.add(mw.name);
      }
      // Promise return → defer; execute() will await it.
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

    // Skip YAML and TypeScript files - `git show` hands back the source, not the
    // workflow JSON this method is expected to return.
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".yaml" || ext === ".yml" || ext === ".ts") {
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

    // Prepare any middlewares not already initialised by the constructor.
    // Sync-prepare middlewares (lint) ran in the constructor so config
    // errors propagate to `new Executor(...)`. Async-prepare middlewares
    // (e.g. authz fetching the actor's groups) run here, once, before the
    // per-workflow loop so the cost is paid once per apply.
    const pending = this.middlewares.filter((m) => !this.preparedNames.has(m.name));
    if (pending.length > 0) {
      await preparePipeline(pending);
      for (const m of pending) this.preparedNames.add(m.name);
    }

    // Duplicate-name check is on by default; opt out with allowDuplicates.
    // Skip on dry-run so a local preview stays cheap and works offline. If
    // the upstream list call fails (auth, transient 5xx), degrade to a
    // warning rather than aborting the whole apply — the proxy does the
    // same in src/proxy/duplicate.ts.
    if (!this.opts.allowDuplicates && !this.opts.dryRun) {
      const checker = new DuplicateChecker(this.workflowService);
      try {
        await checker.loadRemoteWorkflows();
        this.duplicateChecker = checker;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Warning: duplicate-name check skipped — could not list upstream workflows: ${message}`,
        );
      }
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
    await disposePipeline(this.middlewares);
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

    // Pre-write middleware pipeline. Runs every enabled middleware (lint,
    // authz, future policies) before any remote fetch so a broken or
    // unauthorized workflow never causes upstream traffic. Errors mark the
    // op as failed; warnings are recorded on the op but do not block.
    // `--force` intentionally does NOT override this — middleware failures
    // are policy, not merge conflicts.
    if (this.middlewares.length > 0) {
      const verdict = await runPipeline(this.middlewares, {
        workflow,
        rawJSON: undefined,
        mode: "apply",
      });
      op.middlewareViolations = verdict.violations;
      // Preserve `lintViolations` for any consumer that still reads it.
      op.lintViolations = verdict.violations.filter(
        (v) => v.rule !== "authz-denied" && !v.rule.startsWith("authz-"),
      );
      if (verdict.block) {
        op.operation = "error";
        op.blockedByMiddleware = verdict.blockedBy;
        op.error = new Error(
          buildMiddlewareErrorMessage(wf.path, verdict.blockedBy, verdict.violations),
        );
        return op;
      }
    }

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

    // A `.ts` workflow cannot express node IDs — the SDK has no field for them,
    // so the loader derives them from the node names. Adopt the IDs the remote
    // already uses for the same names, otherwise the first apply after a file is
    // converted to `.ts` would rewrite every node ID for no reason.
    if (wf.sourceType === "ts") {
      adoptRemoteNodeIDs(workflow, remoteWorkflow);
    }

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

  /** Strip settings the n8n API exports but rejects on write. */
  private stripWriteUnsupportedSettings(
    settings?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!settings) return undefined;
    const WRITE_UNSUPPORTED_SETTINGS = ["binaryMode", "timeSavedMode", "credentialResolverId"];
    return Object.fromEntries(
      Object.entries(settings).filter(([k]) => !WRITE_UNSUPPORTED_SETTINGS.includes(k)),
    );
  }

  /** Performs the actual create operation. */
  private async executeCreate(wf: WorkflowFile, op: ApplyOperation): Promise<void> {
    const workflow = wf.workflow!;
    const input: WorkflowInput = {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: this.stripWriteUnsupportedSettings(workflow.settings as Record<string, unknown>),
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
      settings: this.stripWriteUnsupportedSettings(workflow.settings as Record<string, unknown>),
      staticData: workflow.staticData,
    };

    // The local timestamp, not the one just fetched from upstream: the claim
    // being made is "my definition is based on this state", and a freshly
    // fetched value would always match and assert nothing.
    const updated = await this.workflowService.updateWorkflow(
      workflow.id!,
      input,
      workflow.updatedAt,
    );
    await this.applyTagsAndProject(updated, workflow, op);
    await updateLocalWorkflowFile(wf.path, await this.settledWorkflow(updated, op));
  }

  /**
   * Returns the workflow as it stands after every post-write operation.
   *
   * Tagging, project transfer and activation are separate API calls that each
   * bump `updatedAt` again, so the response to the update itself is already
   * stale by the time they finish. Stamping a local file with it would leave
   * the file permanently one step behind upstream, and the next edit would read
   * as a conflict. Re-fetch only when one of those calls actually ran.
   */
  private async settledWorkflow(updated: Workflow, op: ApplyOperation): Promise<Workflow> {
    const mutatedAfterWrite =
      op.tagsAdded.length > 0 || op.projectMoved || op.activated !== undefined;
    if (!mutatedAfterWrite || !updated.id) return updated;

    try {
      return await this.workflowService.getWorkflow(updated.id);
    } catch {
      // Non-fatal: the write succeeded, and a stamp that is one step behind is
      // better than failing an apply that already did its job.
      return updated;
    }
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

/**
 * Builds the multi-line error message used when a middleware blocks a
 * workflow. Mirrors the layout of `n8n-cli lint` text output so users see
 * the same `file:line: severity[rule]: message` shape they would when
 * running lint standalone.
 *
 * The summary line names the blocking middleware so users know whether to
 * pass `--no-lint`, drop the authz middleware from `--server-middleware`,
 * or fix the workflow.
 */
function buildMiddlewareErrorMessage(
  filePath: string,
  blockedBy: string | undefined,
  violations: Violation[],
): string {
  const errorOnly = violations.filter((v) => v.severity === "error" || !v.severity);
  const lines = errorOnly.map((v) => formatViolationLine(filePath, v));
  const mwLabel = blockedBy ?? "middleware";
  // Append the bypass hint for the known middleware. Authz has no
  // equivalent bypass flag (dropping it from --server-middleware is an
  // explicit declarative action, not a per-run override), so we only add
  // the lint hint here. The legacy `buildLintErrorMessage` always emitted
  // this tail; keeping it preserves the existing CLI UX and any consumers
  // grepping for "--no-lint to bypass" in apply output.
  const hint = blockedBy === "lint" ? "; pass --no-lint to bypass" : "";
  const summary = `${mwLabel} check failed (${errorOnly.length} error${
    errorOnly.length === 1 ? "" : "s"
  })${hint}`;
  return [summary, ...lines].join("\n  ");
}

/**
 * Rewrites local node IDs to match the remote workflow's, matching on node name.
 *
 * Only used for `.ts` sources, where node IDs are synthesised rather than
 * authored (see `ts/node-ids.ts`). Nodes with no remote counterpart keep their
 * derived ID.
 */
function adoptRemoteNodeIDs(local: Workflow, remote: Workflow): void {
  const remoteIDsByName = new Map<string, string>();
  for (const node of remote.nodes ?? []) {
    if (node.name && node.id) remoteIDsByName.set(node.name, node.id);
  }
  if (remoteIDsByName.size === 0) return;

  for (const node of local.nodes ?? []) {
    const remoteID = remoteIDsByName.get(node.name);
    if (remoteID) node.id = remoteID;
  }
}
