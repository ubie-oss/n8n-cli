import type { Node, Workflow } from "@/api/types.ts";
import { globMatch } from "@/common/mcp.ts";
import { readStringArray } from "./mcp-tool-description.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

const RULE_NAME = "unauthenticated-webhook";

/**
 * Trigger types that publish an HTTP endpoint and can carry n8n's own
 * authentication.
 *
 * Schedule triggers are absent on purpose: they have no endpoint, so there is
 * nothing to authenticate. The four listed here all expose `authentication` in
 * their parameters, which is why a policy about it can be written at all.
 *
 * Two kinds of HTTP entry point are deliberately out of reach. A Wait node
 * publishes a resume URL but has no authentication parameter at all, so there
 * is no setting to require. App triggers (Slack, Gmail, GitHub) do expose
 * `authentication`, but it names how n8n authenticates *to* that service, not
 * how the incoming request is checked — reading it here would judge the wrong
 * direction.
 */
const HTTP_TRIGGER_TYPES: readonly string[] = [
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.formTrigger",
  "@n8n/n8n-nodes-langchain.chatTrigger",
  "@n8n/n8n-nodes-langchain.mcpTrigger",
];

/** What a node's `authentication` parameter resolves to, statically. */
type AuthState =
  | { kind: "authenticated" }
  | { kind: "none"; declared: boolean }
  | { kind: "expression"; raw: string };

/**
 * Refuses webhook, form, chat and MCP triggers that accept requests without
 * authentication, unless the workflow is named in `allowWorkflows`.
 *
 * `authentication: none` is not a setting so much as the absence of one: it is
 * n8n's default, it is what a node gets when the key is simply missing, and
 * what it produces is a public HTTP endpoint that runs a workflow with that
 * workflow's credentials. The endpoint stays public whether or not anyone
 * intended it, and nothing about the definition says out loud that it is.
 *
 * **With no options this rule denies every unauthenticated trigger**, which is
 * the opposite of how the `mcp-*` rules behave. The asymmetry is deliberate.
 * Those rules describe a convention, and a convention that was never configured
 * cannot be guessed. This rule describes an exposure, and an exposure that was
 * never configured is still an exposure — so the default has to be the strict
 * end, or an instance that forgot to configure the rule is exactly the instance
 * running unprotected endpoints.
 *
 * It also makes the rule usable as a gate. A server-side check (n8n-cli's
 * `proxy`) runs with whatever `.n8nlintrc.json` it can find, which in a
 * container is none: rules there see their default severity and no options. A
 * rule that needs an allowlist to do anything would be inert precisely where
 * enforcement matters, and an allowlist shipped with the gate would be an
 * allowlist nobody reviews. Leaving the gate with no options and putting
 * `allowWorkflows` only in the repository's own config means every exception is
 * a diff in the repository that owns the workflow.
 *
 * Options:
 *   - `allowWorkflows`: workflow ids permitted to carry an unauthenticated
 *     trigger. Ids, not names: a name is edited in the n8n UI without review,
 *     and a renamed workflow silently leaving the allowlist would grant the
 *     exception to whatever is renamed into it.
 *   - `requireAuthPaths`: `*`-globs for entry paths that must always be
 *     authenticated, allowlist or not. For path prefixes reserved by convention
 *     for callers that *can* authenticate (a CLI test hook, an on-demand
 *     trigger), where `none` means the convention was broken rather than an
 *     exception being taken.
 */
export const unauthenticatedWebhookRule: Rule = {
  name: RULE_NAME,
  description: "Check that HTTP triggers require authentication unless the workflow is allowlisted",
  defaultSeverity: "error",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const allowWorkflows = readStringArray(options?.allowWorkflows);
    const requireAuthPaths = readStringArray(options?.requireAuthPaths);
    const allowlisted = workflow.id !== undefined && allowWorkflows.includes(workflow.id);

    const violations: Violation[] = [];

    for (const node of workflow.nodes) {
      // A disabled node is not registered, so it publishes nothing.
      if (node.disabled === true) continue;
      if (!HTTP_TRIGGER_TYPES.includes(node.type)) continue;

      const auth = readAuthentication(node);
      if (auth.kind === "authenticated") continue;

      if (auth.kind === "expression") {
        violations.push({
          rule: RULE_NAME,
          severity: "error",
          message:
            `Node "${node.name}" (${node.type}) sets authentication from an expression ` +
            `(${auth.raw}), so whether the endpoint is public cannot be decided from the ` +
            "definition. Write a literal authentication method.",
        });
        continue;
      }

      const path = readPath(node);
      const reserved =
        path === undefined ? undefined : requireAuthPaths.find((glob) => globMatch(glob, path));

      if (reserved !== undefined) {
        violations.push({
          rule: RULE_NAME,
          severity: "error",
          message:
            `Node "${node.name}" has path "${path}", which is reserved for authenticated entry ` +
            `points (matches "${reserved}"), but ${describeAuth(auth)}. Callers of these paths ` +
            "can authenticate, so this is a broken convention rather than an exception — set the " +
            "authentication method the convention expects. Allowlisting the workflow does not " +
            "cover it.",
        });
        continue;
      }

      if (allowlisted) continue;

      violations.push({
        rule: RULE_NAME,
        severity: "error",
        message:
          `Node "${node.name}" (${node.type}) ${describeAuth(auth)}, publishing an HTTP endpoint ` +
          `that anyone who can reach this n8n can run${
            path === undefined ? "" : ` (path "${path}")`
          } — with this workflow's credentials. Give the trigger an authentication method, or, ` +
          `if the caller genuinely cannot authenticate, ${describeAllowlistFix(workflow)}.`,
      });
    }

    return violations;
  },
};

/**
 * Reads `parameters.authentication`.
 *
 * A missing key is not distinguished from an explicit `"none"` for the purpose
 * of the check — n8n treats both as no authentication — but it is reported
 * differently, because "you chose none" and "the key is not there" send an
 * author to different places in the definition.
 */
function readAuthentication(node: Node): AuthState {
  const raw = node.parameters?.authentication;
  if (raw === undefined || raw === null || raw === "") return { kind: "none", declared: false };
  if (typeof raw !== "string") return { kind: "none", declared: false };
  if (raw.startsWith("=") || raw.includes("{{")) return { kind: "expression", raw };
  if (raw === "none") return { kind: "none", declared: true };
  return { kind: "authenticated" };
}

function describeAuth(auth: AuthState): string {
  if (auth.kind === "none" && auth.declared) return "accepts requests without authentication";
  return "declares no authentication method, so n8n accepts requests without any";
}

function describeAllowlistFix(workflow: Workflow): string {
  if (workflow.id === undefined) {
    return (
      `add the workflow's id to the "${RULE_NAME}" rule's allowWorkflows — this workflow has no ` +
      "id yet, so it has to be created first"
    );
  }
  return `add "${workflow.id}" to the "${RULE_NAME}" rule's allowWorkflows`;
}

/**
 * The path the endpoint is published under, when the definition states one.
 *
 * n8n falls back to the node's `webhookId` when `path` is unset. That UUID is
 * not something a path convention should be written against, so an unset path
 * is reported as no path rather than as the UUID.
 */
function readPath(node: Node): string | undefined {
  const raw = node.parameters?.path;
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}
