import type { Workflow } from "@/api/types.ts";
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

    if (!isMcpExposed(workflow, mcpTags)) return [];

    const violations: Violation[] = [];
    const present = new Set((workflow.tags ?? []).map((t) => t.name));

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
