import type { Workflow } from "@/api/types.ts";
import { findEntryTrigger, globMatch } from "@/common/mcp.ts";
import { readStringArray } from "./mcp-tool-description.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/**
 * True when the workflow is reachable through n8n's instance-level MCP server,
 * or declares that it wants to be.
 *
 * `settings.availableInMCP` is the switch n8n itself reads. `mcpTags` lets a
 * repository state the same intent in a form that survives a server too old to
 * accept the setting over the public API (n8n < 2.17.0 dropped it silently),
 * and gives the proxy something to gate on that a workflow author cannot flip
 * from the n8n UI without the change showing up in review.
 */
export function isMcpExposed(workflow: Workflow, mcpTags: string[] = []): boolean {
  if (workflow.settings?.availableInMCP === true) return true;
  return hasAnyTag(workflow, mcpTags);
}

function hasAnyTag(workflow: Workflow, tags: string[]): boolean {
  if (tags.length === 0) return false;
  const present = new Set((workflow.tags ?? []).map((t) => t.name));
  return tags.some((t) => present.has(t));
}

/**
 * Enforces a repository's own rule about which workflows may be exposed over
 * MCP.
 *
 * n8n's `Available in MCP` toggle is per-workflow and can be flipped in the UI
 * by anyone with edit rights, so on its own it is not a policy — it is whatever
 * the last person clicked. This rule turns it into one: an exposed workflow has
 * to look like the repository says an MCP tool looks.
 *
 * Every check is opt-in. With no options the rule does nothing, because there is
 * no convention it could guess.
 *
 * Options:
 *   - `requireTags`: tag names an MCP-exposed workflow must carry (all of them).
 *   - `namePattern`: regular expression the workflow name must match.
 *   - `mcpTags`: tags that mean "meant for MCP" even when the setting is off.
 *     Used both to widen what counts as exposed and, with `requireSetting`, to
 *     catch a workflow whose tag and setting disagree.
 *   - `requireSetting`: when true, a workflow carrying an `mcpTags` tag must
 *     also have `settings.availableInMCP` set — otherwise the tag promises an
 *     agent access that n8n refuses.
 *   - `entryPathPattern`: a `*`-glob the *entry trigger's* path must match.
 *     The entry trigger is the one n8n would actually fire — the first
 *     non-disabled Schedule/Webhook/Form/Chat node, in array order. Pass the
 *     same glob the proxy runs with (`--mcp-entry-path-pattern`) so CI and the
 *     gate cannot disagree about which workflows are reachable.
 */
export const mcpExposureRule: Rule = {
  name: "mcp-exposure",
  description: "Check that MCP-exposed workflows match the repository's MCP conventions",
  defaultSeverity: "warning",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const mcpTags = readStringArray(options?.mcpTags);
    const requireTags = readStringArray(options?.requireTags);
    const namePattern = typeof options?.namePattern === "string" ? options.namePattern : undefined;
    const requireSetting = options?.requireSetting === true;
    const entryPathPattern =
      typeof options?.entryPathPattern === "string" && options.entryPathPattern !== ""
        ? options.entryPathPattern
        : undefined;

    if (!isMcpExposed(workflow, mcpTags)) return [];

    const violations: Violation[] = [];
    const present = new Set((workflow.tags ?? []).map((t) => t.name));

    if (entryPathPattern !== undefined) {
      violations.push(...checkEntryPath(workflow, entryPathPattern));
    }

    for (const tag of requireTags) {
      if (!present.has(tag)) {
        violations.push({
          rule: "mcp-exposure",
          severity: "warning",
          message: `Workflow is exposed over MCP but does not carry the required tag "${tag}".`,
        });
      }
    }

    if (namePattern !== undefined) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(namePattern);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        violations.push({
          rule: "mcp-exposure",
          severity: "error",
          message: `Invalid namePattern option: ${message}`,
        });
      }
      if (re && !re.test(workflow.name)) {
        violations.push({
          rule: "mcp-exposure",
          severity: "warning",
          message: `Workflow name "${workflow.name}" does not match the MCP naming convention /${namePattern}/.`,
        });
      }
    }

    if (requireSetting && workflow.settings?.availableInMCP !== true) {
      violations.push({
        rule: "mcp-exposure",
        severity: "warning",
        message:
          "Workflow is tagged for MCP but settings.availableInMCP is not set, " +
          "so n8n refuses get_workflow_details and execute_workflow for it.",
      });
    }

    return violations;
  },
};

/**
 * Checks the trigger n8n would actually enter this workflow through.
 *
 * The failure this catches is not a missing feature but a silent one: n8n picks
 * the *first* supported trigger in `nodes` order and gives the caller no way to
 * choose, so a workflow can be perfectly exposed and still be entered somewhere
 * nobody intended — through a test hook, or through a nightly Schedule. Node
 * order is invisible in review, which is why a machine has to say it out loud.
 *
 * Messages name the node, because "which one fires" is the question an author
 * cannot otherwise answer without reading the whole definition.
 */
function checkEntryPath(workflow: Workflow, pattern: string): Violation[] {
  const entry = findEntryTrigger(workflow.nodes);

  if (entry === null) {
    return [
      {
        rule: "mcp-exposure",
        severity: "warning",
        message:
          "Workflow is exposed over MCP but has no trigger n8n can enter it through " +
          "(only Schedule, Webhook, Form and Chat triggers count), so execute_workflow fails.",
      },
    ];
  }

  if (entry.path === undefined) {
    return [
      {
        rule: "mcp-exposure",
        severity: "warning",
        message:
          `MCP enters this workflow through "${entry.name}" (${entry.type}), which declares no path, ` +
          `so it cannot match the agent-facing convention /${pattern}/. A Schedule trigger never ` +
          "carries one — if an agent should not be able to fire this workflow on demand, take it " +
          "out of MCP instead.",
      },
    ];
  }

  if (!globMatch(pattern, entry.path)) {
    return [
      {
        rule: "mcp-exposure",
        severity: "warning",
        message:
          `MCP enters this workflow through "${entry.name}" (path "${entry.path}"), which is outside ` +
          `the agent-facing convention /${pattern}/. n8n fires the FIRST supported trigger in node ` +
          "order, so give the agent-facing trigger a matching path and put it first — note that " +
          "`n8n-cli fmt` re-derives node order from canvas position (left to right, then top to " +
          "bottom), so on a workflow that gets formatted the entry is whichever matching trigger " +
          "sits leftmost.",
      },
    ];
  }

  return [];
}
