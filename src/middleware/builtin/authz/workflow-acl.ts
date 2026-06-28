import type { Workflow } from "@/api/types.ts";
import { type CompiledJSONPath, compileJSONPath } from "@/middleware/jsonpath.ts";
import type { WorkflowACLSpec } from "./types.ts";

/**
 * Extracts the set of group identifiers that are allowed to edit a given
 * workflow. The location and shape of that information is fully
 * user-supplied via `WorkflowACLSpec` — this module assumes nothing about
 * tag conventions, field names, or prefix schemes.
 *
 * Returns an empty array when the workflow has no ACL markers — callers
 * (middleware.ts) treat that as "no allowed groups declared", which
 * deliberately denies the write. That keeps the policy "if you don't
 * declare an ACL, nobody can edit it through this gate" which is the
 * safer default.
 */
export class WorkflowACLExtractor {
  private readonly path: CompiledJSONPath;
  private readonly stripPrefix: string;

  constructor(spec: WorkflowACLSpec) {
    this.path = compileJSONPath(spec.extract);
    this.stripPrefix = spec.stripPrefix ?? "";
  }

  extract(workflow: Workflow | null): string[] {
    if (!workflow) return [];
    const matches = this.path.evaluate(workflow);
    const out: string[] = [];
    for (const m of matches) {
      if (typeof m !== "string") continue;
      if (this.stripPrefix) {
        if (!m.startsWith(this.stripPrefix)) continue;
        out.push(m.slice(this.stripPrefix.length));
      } else {
        out.push(m);
      }
    }
    return out;
  }
}
