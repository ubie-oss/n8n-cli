import type { Workflow } from "@/api/types.ts";
import { isMcpExposed } from "./mcp-exposure.ts";
import type { Rule } from "./rule.ts";
import type { Violation } from "./violation.ts";

/**
 * n8n truncates a workflow description at this length from v2.27.0. Text past
 * it is dropped silently, so an author who wrote past the limit is not
 * describing the tool they think they are.
 */
export const MAX_DESCRIPTION_LENGTH = 255;

/** Below this a description is unlikely to tell an agent when to call the tool. */
const DEFAULT_MIN_LENGTH = 20;

/**
 * Validates that a workflow reachable over n8n's MCP server carries a
 * description worth reading.
 *
 * A workflow with `settings.availableInMCP` is not just automation any more: an
 * agent decides whether to call it from the workflow's `description`, which
 * n8n hands to the model as the tool description in `search_workflows` and
 * `get_workflow_details`. An empty one leaves the model guessing from the
 * workflow name alone.
 *
 * Options:
 *   - `mcpTags`: tag names that also mean "exposed over MCP", for repositories
 *     that mark intent with a tag. Any one of them is enough.
 *   - `minLength`: shortest description accepted (default 20, 0 disables).
 *   - `maxLength`: longest description accepted (default 255, n8n's own limit).
 */
export const mcpToolDescriptionRule: Rule = {
  name: "mcp-tool-description",
  description: "Check that MCP-exposed workflows carry a usable description",
  defaultSeverity: "warning",
  check(
    workflow: Workflow | null,
    _rawJSON: string,
    options?: Record<string, unknown>,
  ): Violation[] {
    if (!workflow) return [];

    const mcpTags = readStringArray(options?.mcpTags);
    if (!isMcpExposed(workflow, mcpTags)) return [];

    const minLength = readNonNegativeInt(options?.minLength) ?? DEFAULT_MIN_LENGTH;
    const maxLength = readNonNegativeInt(options?.maxLength) ?? MAX_DESCRIPTION_LENGTH;

    const description = (workflow.description ?? "").trim();

    if (description === "") {
      return [
        {
          rule: "mcp-tool-description",
          severity: "warning",
          message:
            "Workflow is exposed over MCP but has no description. " +
            "The description is what an agent reads to decide whether to call this workflow — " +
            "state what it does, what input it expects, and when to use it.",
        },
      ];
    }

    const violations: Violation[] = [];
    // Count in code points: n8n's limit is on the string, and a Japanese
    // description would otherwise be measured in a unit nobody writing it uses.
    const length = [...description].length;

    if (length < minLength) {
      violations.push({
        rule: "mcp-tool-description",
        severity: "warning",
        message: `Workflow description is ${length} characters, shorter than the ${minLength} this repository asks of an MCP-exposed workflow.`,
      });
    }
    if (length > maxLength) {
      violations.push({
        rule: "mcp-tool-description",
        severity: "warning",
        message: `Workflow description is ${length} characters; n8n truncates at ${maxLength}, so the rest never reaches the agent.`,
      });
    }

    return violations;
  },
};

/** Reads a string[] option, ignoring a malformed value rather than throwing. */
export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}
