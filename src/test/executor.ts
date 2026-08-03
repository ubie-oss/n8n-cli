import type { Execution, ExecutionService } from "../api/execution-service.ts";
import { isTerminalStatus } from "../api/execution-service.ts";
import type { Workflow } from "../api/types.ts";
import { callWebhook } from "../api/webhook.ts";
import type { WorkflowService } from "../api/workflow-service.ts";
import type { ClientMiddleware } from "../middleware/types.ts";
import { buildWebhookURL, detectTestWebhook, type WebhookInfo } from "./detector.ts";

/** TestOptions represents options for running a workflow test */
export interface TestOptions {
  data: unknown;
  timeoutMs: number;
  waitExecution: boolean;
  executionTimeoutMs: number;
  pollIntervalMs: number;
  activate: boolean;
  dryRun: boolean;
  showInputs: boolean;
}

/** DefaultTestOptions returns default test options */
export function defaultTestOptions(): TestOptions {
  return {
    data: {},
    timeoutMs: 30_000,
    waitExecution: false,
    executionTimeoutMs: 5 * 60 * 1000,
    pollIntervalMs: 1_000,
    activate: false,
    dryRun: false,
    showInputs: false,
  };
}

/** TestResult represents the result of a workflow test */
export interface TestResult {
  workflow: Workflow;
  webhookNode?: import("../api/types.ts").Node;
  webhookURL: string;
  httpStatus: number;
  httpResponse: string;
  execution?: Execution;
  durationMs: number;
  error?: Error;
}

/** IsSuccess returns true if the test was successful */
export function isTestSuccess(result: TestResult): boolean {
  if (result.error) return false;
  if (result.httpStatus < 200 || result.httpStatus >= 300) return false;
  if (result.execution && result.execution.status !== "success") return false;
  return true;
}

/** WorkflowInactiveError is returned when the workflow is not active */
export class WorkflowInactiveError extends Error {
  readonly workflowId: string;
  readonly workflowName: string;

  constructor(workflowId: string, workflowName: string) {
    super(`workflow "${workflowName}" (${workflowId}) is not active`);
    this.name = "WorkflowInactiveError";
    this.workflowId = workflowId;
    this.workflowName = workflowName;
  }

  hint(): string {
    return "Use --activate flag to automatically activate the workflow, or activate it manually in n8n UI";
  }
}

/** Executor handles workflow test execution */
export class Executor {
  constructor(
    private readonly baseURL: string,
    private readonly workflowService: WorkflowService,
    private readonly executionService: ExecutionService,
    /**
     * Egress middlewares for the webhook call itself.
     *
     * The execution lookups below already go through the API client, so they
     * carry whatever a gateway requires. The webhook POST does not use that
     * client — its URL sits outside `/api/v1` — so without the chain here the
     * first request of a test is the one request that arrives unauthenticated,
     * and the whole command fails at the edge on an otherwise working setup.
     */
    private readonly clientMiddlewares: ClientMiddleware[] = [],
  ) {}

  /** Execute runs a test against a workflow */
  async execute(workflow: Workflow, opts?: Partial<TestOptions>): Promise<TestResult> {
    const options = { ...defaultTestOptions(), ...opts };
    const startTime = Date.now();

    const result: TestResult = {
      workflow,
      webhookURL: "",
      httpStatus: 0,
      httpResponse: "",
      durationMs: 0,
    };

    // Detect test webhook
    let webhookInfo: WebhookInfo;
    try {
      webhookInfo = detectTestWebhook(workflow);
    } catch (e) {
      result.error = e instanceof Error ? e : new Error(String(e));
      result.durationMs = Date.now() - startTime;
      return result;
    }

    result.webhookNode = webhookInfo.node;
    webhookInfo.fullURL = buildWebhookURL(this.baseURL, webhookInfo.path);
    result.webhookURL = webhookInfo.fullURL;

    // Dry run: just return the URL
    if (options.dryRun) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Check if workflow is active
    if (!workflow.active) {
      if (options.activate) {
        try {
          const activated = await this.workflowService.activateWorkflow(workflow.id!);
          result.workflow = activated;
        } catch (e) {
          result.error = new Error(
            `failed to activate workflow: ${e instanceof Error ? e.message : String(e)}`,
          );
          result.durationMs = Date.now() - startTime;
          return result;
        }
      } else {
        result.error = new WorkflowInactiveError(workflow.id ?? "", workflow.name);
        result.durationMs = Date.now() - startTime;
        return result;
      }
    }

    // Execute webhook
    try {
      const [status, response] = await this.callWebhook(webhookInfo, options);
      result.httpStatus = status;
      result.httpResponse = response;
    } catch (e) {
      result.error = e instanceof Error ? e : new Error(String(e));
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Wait for execution if requested
    if (options.waitExecution) {
      try {
        const exec = await this.waitForLatestExecution(workflow.id!, options);
        result.execution = exec;
      } catch (e) {
        result.error = new Error(
          `failed to get execution result: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /** callWebhook sends an HTTP request to the webhook */
  private async callWebhook(info: WebhookInfo, opts: TestOptions): Promise<[number, string]> {
    // Authenticates the request at n8n's own webhook node (header auth), which
    // is a separate concern from the gateway credentials the middleware chain
    // attaches.
    const token = process.env.N8N_CLI_TEST_TOKEN;

    const { status, body } = await callWebhook(info.fullURL, {
      method: info.httpMethod,
      data: opts.data,
      timeoutMs: opts.timeoutMs,
      headers: token ? { "x-n8n-cli-test-token": token } : {},
      clientMiddlewares: this.clientMiddlewares,
    });
    return [status, body];
  }

  /** waitForLatestExecution waits for the most recent execution to complete */
  private async waitForLatestExecution(workflowId: string, opts: TestOptions): Promise<Execution> {
    // Give n8n a moment to create the execution record
    await new Promise((resolve) => setTimeout(resolve, 500));

    const exec = await this.executionService.getLatestExecution(workflowId);
    if (!exec) {
      throw new Error(`no execution found for workflow ${workflowId}`);
    }

    if (isTerminalStatus(exec.status)) {
      return exec;
    }

    return this.executionService.waitForExecution(
      exec.id,
      opts.executionTimeoutMs,
      opts.pollIntervalMs,
    );
  }
}
