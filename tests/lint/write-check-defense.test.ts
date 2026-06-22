import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import {
  checkWorkflowForWrite,
  LintConfigLoadError,
  prepareWriteLintContext,
} from "@/lint/write-check.ts";

/**
 * Defensive-path tests for the write-time lint helpers. Covers the two
 * regressions that the xhigh-effort code review surfaced:
 *
 *   - a malformed `.n8nlintrc.json` must produce a typed `LintConfigLoadError`
 *     (not a raw `SyntaxError`) so callers can present a friendly message
 *   - a rule that throws must NOT crash the calling command; it must be
 *     downgraded to a synthetic `linter-internal-error` violation, mirroring
 *     `src/proxy/enforcer.ts`
 *
 * Also pins the `startDir` discovery anchor so `apply --dir workflows/` can
 * pick up an in-tree `.n8nlintrc.json`.
 */

function goodWorkflow(): Workflow {
  return {
    name: "wf",
    active: false,
    nodes: [],
    connections: {},
  };
}

describe("prepareWriteLintContext defensive paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-check-defense-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("LintConfigLoadError is thrown when the explicit configPath is malformed JSON", () => {
    const badPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(badPath, "{ this is not json");

    expect(() => prepareWriteLintContext(badPath)).toThrow(LintConfigLoadError);
  });

  test("LintConfigLoadError carries the resolved configPath and original message", () => {
    const badPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(badPath, '{ "rules": { "x": "wat" } }');

    try {
      prepareWriteLintContext(badPath);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LintConfigLoadError);
      const e = err as LintConfigLoadError;
      expect(e.configPath).toBe(badPath);
      expect(e.message).toContain(badPath);
    }
  });

  test("startDir anchors auto-discovery so an in-tree config wins over cwd", () => {
    // The CLI is invoked from process.cwd(), but apply passes the workflow
    // directory in. Putting the config under the workflow dir must take
    // priority — and the call must succeed.
    const workflowDir = path.join(tmpDir, "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const cfgPath = path.join(workflowDir, ".n8nlintrc.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ rules: { "required-fields": "off" } }));

    const ctx = prepareWriteLintContext(undefined, undefined, workflowDir);
    expect(ctx.configPath).toBe(cfgPath);
    // The disabled rule must not appear in the resolved rule list.
    expect(ctx.rules.some((r) => r.rule.name === "required-fields")).toBe(false);
  });

  test("absent config is not an error; defaults are used", () => {
    // findConfigFile walks to filesystem root from startDir. If no
    // .n8nlintrc.json is discovered we fall through to defaults.
    const ctx = prepareWriteLintContext(undefined, undefined, tmpDir);
    // Some rule should still be in play with defaults.
    expect(ctx.rules.length).toBeGreaterThan(0);
  });
});

describe("checkWorkflowForWrite defensive paths", () => {
  test("a rule that throws is downgraded to linter-internal-error rather than crashing the caller", () => {
    // Build a context with exactly one rule that explodes. We do this by
    // forging a `WriteLintContext` so the test stays isolated from rule
    // registry churn.
    const ctx = {
      rules: [
        {
          rule: {
            name: "boom",
            description: "always throws",
            defaultSeverity: "error" as const,
            check() {
              throw new TypeError("kaboom");
            },
          },
          severity: "error" as const,
        },
      ],
      config: null,
    };

    const result = checkWorkflowForWrite(goodWorkflow(), undefined, ctx);

    expect(result.hasErrors).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe("linter-internal-error");
    expect(result.violations[0]?.message).toContain("kaboom");
  });

  test("a clean run with normal rules returns no violations", () => {
    const ctx = prepareWriteLintContext();
    const result = checkWorkflowForWrite(goodWorkflow(), undefined, ctx);
    expect(result.hasErrors).toBe(false);
  });
});
