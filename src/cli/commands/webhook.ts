import type { Command } from "commander";
import type { Workflow } from "../../api/types.ts";
import { callWebhook } from "../../api/webhook.ts";
import {
  buildWebhookURL,
  listWebhookNodes,
  resolveWebhookNode,
  WebhookNodeNotFoundError,
} from "../../webhook/resolver.ts";
import { resolveContext } from "../root.ts";

/**
 * Registers `webhook`, a primitive for calling a workflow's webhook through
 * the CLI's authenticated egress path.
 *
 * Why this exists at all, given `curl`: when n8n sits behind a gateway that
 * authenticates callers per request, the credentials are minted by the egress
 * middleware chain (`N8N_CLIENT_MIDDLEWARES`) inside this process. Every other
 * command already goes through it; webhook URLs sit outside `/api/v1` and had
 * no way in. Reproducing the chain outside the CLI means reimplementing token
 * minting, impersonation and caching — so the one thing that genuinely belongs
 * here is the transport.
 *
 * Everything else is left to the caller. This command takes no position on
 * which webhooks are safe to call, what they should be named, or whether they
 * ought to return data: those are deployment policy, they differ per
 * organization, and a naming convention compiled into a released binary is a
 * convention nobody can change. Callers that need such a policy enforce it in
 * the layer that owns it, and pass this command a node name.
 */
export function registerWebhookCommand(program: Command): void {
  const webhook = program
    .command("webhook")
    .description("Call a workflow's webhook through the authenticated egress path");

  webhook
    .command("list")
    .description("List a workflow's webhook nodes")
    .argument("<workflow-id>", "Workflow ID")
    .action(async (workflowId: string) => {
      const ctx = resolveContext(program);
      const workflow = await getWorkflow(ctx, workflowId);
      const nodes = listWebhookNodes(workflow).map((w) => ({
        node: w.node.name,
        path: w.path,
        httpMethod: w.httpMethod,
        url: buildWebhookURL(ctx.config.apiURL, w.path),
      }));

      if (ctx.config.output === "json") {
        console.log(JSON.stringify(nodes, null, 2));
        return;
      }
      if (nodes.length === 0) {
        console.log("No enabled webhook nodes.");
        return;
      }
      for (const n of nodes) {
        console.log(`${n.httpMethod}  ${n.node}`);
        console.log(`      ${n.url}`);
      }
    });

  webhook
    .command("call")
    .description("Call one named webhook node and return as soon as n8n responds")
    .argument("<workflow-id>", "Workflow ID")
    .requiredOption(
      "-n, --node <name>",
      "Exact name of the webhook node to call. Required: this command never picks one for you",
    )
    .option("-d, --data <json>", "JSON body to send")
    .option("--timeout <ms>", "HTTP request timeout in milliseconds", "30000")
    .option("--dry-run", "Print the resolved URL without calling it", false)
    .option(
      "--allow-inactive",
      "Call even if the workflow is inactive (its webhook is probably unregistered)",
      false,
    )
    .action(async (workflowId: string, opts: Record<string, unknown>) => {
      const ctx = resolveContext(program);
      const workflow = await getWorkflow(ctx, workflowId);

      let data: unknown;
      if (typeof opts.data === "string" && opts.data) {
        try {
          data = JSON.parse(opts.data);
        } catch (e) {
          fail(`invalid JSON data: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      let resolved: ReturnType<typeof resolveWebhookNode>;
      try {
        resolved = resolveWebhookNode(workflow, String(opts.node));
      } catch (e) {
        if (e instanceof WebhookNodeNotFoundError) {
          console.error(`Error: ${e.message}`);
          console.error(
            `List what this workflow exposes with:\n  n8n-cli webhook list ${workflowId}`,
          );
          process.exit(1);
        }
        fail(e instanceof Error ? e.message : String(e));
      }

      const url = buildWebhookURL(ctx.config.apiURL, resolved.path);

      if (opts.dryRun) {
        report(ctx, { workflowId, node: resolved.node.name, url, dryRun: true }, () => {
          console.log(`Would call: ${resolved.httpMethod} ${url}`);
        });
        return;
      }

      // An inactive workflow's webhook is not registered, so the call 404s.
      // Overridable rather than fatal: n8n also serves a test-mode webhook for
      // an inactive workflow while its editor is open.
      if (!workflow.active && !opts.allowInactive) {
        console.error(
          `Error: workflow "${workflow.name}" (${workflowId}) is not active, so its webhook is probably not registered.`,
        );
        console.error("Activate it, or pass --allow-inactive to call anyway.");
        process.exit(1);
      }

      let status: number;
      let body: string;
      try {
        ({ status, body } = await callWebhook(url, {
          method: resolved.httpMethod,
          data,
          timeoutMs: Number(opts.timeout),
          headers: extraHeaders(),
          clientMiddlewares: ctx.clientMiddlewares,
        }));
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }

      report(ctx, { workflowId, node: resolved.node.name, url, status, body }, () => {
        console.log(`Called: ${resolved.node.name} (${workflowId})`);
        console.log(`  Status: ${status}`);
        if (body) console.log(`  Response: ${body.slice(0, 1000)}`);
      });

      if (status < 200 || status >= 300) process.exit(1);
    });
}

/**
 * Header the caller's own shared secret goes in, when the webhook node uses
 * n8n's header auth. Separate from anything the egress chain attaches: that
 * authenticates the caller to a gateway, this authenticates the request to n8n.
 */
const WEBHOOK_TOKEN_HEADER = "x-n8n-webhook-token";
const WEBHOOK_TOKEN_ENV = "N8N_WEBHOOK_TOKEN";
const WEBHOOK_TOKEN_HEADER_ENV = "N8N_WEBHOOK_TOKEN_HEADER";

function extraHeaders(): Record<string, string> {
  const token = process.env[WEBHOOK_TOKEN_ENV];
  if (!token) return {};
  return { [process.env[WEBHOOK_TOKEN_HEADER_ENV] || WEBHOOK_TOKEN_HEADER]: token };
}

async function getWorkflow(
  ctx: ReturnType<typeof resolveContext>,
  workflowId: string,
): Promise<Workflow> {
  try {
    return await ctx.workflowService.getWorkflow(workflowId);
  } catch (e) {
    return fail(`failed to get workflow: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function report(
  ctx: ReturnType<typeof resolveContext>,
  payload: Record<string, unknown>,
  text: () => void,
): void {
  if (ctx.config.output === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    text();
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}
