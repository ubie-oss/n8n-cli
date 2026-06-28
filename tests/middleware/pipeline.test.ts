import { describe, expect, test } from "bun:test";
import { runPipeline } from "@/middleware/pipeline.ts";
import type { MiddlewareVerdict, PreWriteContext, PreWriteMiddleware } from "@/middleware/types.ts";

const baseCtx: PreWriteContext = { workflow: null, mode: "proxy" };

function mw(name: string, verdict: MiddlewareVerdict): PreWriteMiddleware {
  return { name, evaluate: () => verdict };
}

function asyncMw(name: string, verdict: MiddlewareVerdict): PreWriteMiddleware {
  return { name, evaluate: () => Promise.resolve(verdict) };
}

function throwingMw(name: string, message: string): PreWriteMiddleware {
  return {
    name,
    evaluate: () => {
      throw new Error(message);
    },
  };
}

describe("runPipeline", () => {
  test("empty chain passes", async () => {
    const v = await runPipeline([], baseCtx);
    expect(v.block).toBe(false);
    expect(v.violations).toEqual([]);
  });

  test("all-pass chain passes and collects warnings", async () => {
    const a = mw("a", {
      block: false,
      violations: [{ rule: "a-warn", severity: "warning", message: "soft" }],
    });
    const b = mw("b", { block: false, violations: [] });
    const v = await runPipeline([a, b], baseCtx);
    expect(v.block).toBe(false);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]?.rule).toBe("a-warn");
  });

  test("short-circuits at first blocker, downstream not invoked", async () => {
    let bCalled = false;
    const blocker = mw("lint", {
      block: true,
      violations: [{ rule: "x", severity: "error", message: "boom" }],
      denial: { status: 422, error: "workflow_lint_failed", message: "boom" },
    });
    const after: PreWriteMiddleware = {
      name: "authz",
      evaluate: () => {
        bCalled = true;
        return { block: false, violations: [] };
      },
    };
    const v = await runPipeline([blocker, after], baseCtx);
    expect(v.block).toBe(true);
    expect(v.blockedBy).toBe("lint");
    expect(v.denial?.status).toBe(422);
    expect(bCalled).toBe(false);
  });

  test("violations from earlier passing mw are preserved when later one blocks", async () => {
    const warn = mw("lint", {
      block: false,
      violations: [{ rule: "soft", severity: "warning", message: "hmm" }],
    });
    const blocker = mw("authz", {
      block: true,
      violations: [{ rule: "denied", severity: "error", message: "no" }],
      denial: { status: 403, error: "workflow_authz_denied", message: "no" },
    });
    const v = await runPipeline([warn, blocker], baseCtx);
    expect(v.block).toBe(true);
    expect(v.blockedBy).toBe("authz");
    expect(v.violations.map((x) => x.rule)).toEqual(["soft", "denied"]);
  });

  test("async middleware is awaited", async () => {
    const a = asyncMw("a", { block: false, violations: [] });
    const v = await runPipeline([a], baseCtx);
    expect(v.block).toBe(false);
  });

  test("a throwing middleware blocks with synthetic violation", async () => {
    const v = await runPipeline([throwingMw("bad", "boom")], baseCtx);
    expect(v.block).toBe(true);
    expect(v.blockedBy).toBe("bad");
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]?.rule).toBe("bad-internal-error");
    expect(v.denial?.status).toBe(500);
  });
});
