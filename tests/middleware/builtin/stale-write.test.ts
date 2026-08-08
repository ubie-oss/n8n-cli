import { describe, expect, test } from "bun:test";
import { BASE_UPDATED_AT_HEADER } from "@/api/headers.ts";
import type { Workflow } from "@/api/types.ts";
import { staleWriteFactory } from "@/middleware/builtin/stale-write/factory.ts";
import { StaleWriteMiddleware } from "@/middleware/builtin/stale-write/middleware.ts";
import type { StaleWriteOptions } from "@/middleware/builtin/stale-write/types.ts";
import type { ServerMiddlewareContext } from "@/middleware/types.ts";

/**
 * The guard's decision table. Each test fixes one axis: what the caller
 * claimed, what upstream stores, and what the operator configured.
 */

const STORED = "2026-03-01T10:00:00.000Z";
const OLDER = "2026-02-01T10:00:00.000Z";

function options(overrides: Partial<StaleWriteOptions> = {}): StaleWriteOptions {
  return {
    enforce: "error",
    onMissingBase: "allow",
    onError: "deny",
    actions: ["update"],
    ...overrides,
  };
}

interface ContextOverrides {
  base?: string;
  stored?: Workflow | null;
  storedError?: Error;
  action?: string;
  workflowId?: string;
  mode?: ServerMiddlewareContext["mode"];
  omitFetcher?: boolean;
}

function context(overrides: ContextOverrides = {}): ServerMiddlewareContext {
  const headers = new Headers();
  if (overrides.base) headers.set(BASE_UPDATED_AT_HEADER, overrides.base);

  const stored =
    overrides.stored === undefined
      ? ({
          id: "wf1",
          name: "x",
          active: false,
          nodes: [],
          connections: {},
          updatedAt: STORED,
        } as Workflow)
      : overrides.stored;

  return {
    workflow: null,
    request: new Request("http://proxy/api/v1/workflows/wf1", { method: "PUT", headers }),
    mode: overrides.mode ?? "proxy",
    action: overrides.action ?? "update",
    workflowId: overrides.workflowId ?? "wf1",
    fetchStoredWorkflow: overrides.omitFetcher
      ? undefined
      : async () => {
          if (overrides.storedError) throw overrides.storedError;
          return stored;
        },
  };
}

describe("StaleWriteMiddleware", () => {
  test("passes when the declared base matches the stored state", async () => {
    const verdict = await new StaleWriteMiddleware(options()).evaluate(context({ base: STORED }));
    expect(verdict.block).toBe(false);
    expect(verdict.violations).toEqual([]);
  });

  test("blocks with 409 when upstream has moved on", async () => {
    const verdict = await new StaleWriteMiddleware(options()).evaluate(context({ base: OLDER }));
    expect(verdict.block).toBe(true);
    expect(verdict.denial?.status).toBe(409);
    expect(verdict.denial?.error).toBe("workflow_stale_write");
    expect(verdict.denial?.message).toContain(STORED);
    expect(verdict.denial?.message).toContain(OLDER);
  });

  test("blocks a base newer than the stored state too", async () => {
    const verdict = await new StaleWriteMiddleware(options()).evaluate(
      context({ base: "2026-04-01T10:00:00.000Z" }),
    );
    expect(verdict.block).toBe(true);
  });

  test("treats equivalent timestamp spellings as the same instant", async () => {
    const verdict = await new StaleWriteMiddleware(options()).evaluate(
      context({ base: "2026-03-01T10:00:00.000+00:00" }),
    );
    expect(verdict.block).toBe(false);
  });

  test("warn mode reports the conflict without blocking", async () => {
    const verdict = await new StaleWriteMiddleware(options({ enforce: "warn" })).evaluate(
      context({ base: OLDER }),
    );
    expect(verdict.block).toBe(false);
    expect(verdict.violations[0]?.rule).toBe("stale-write");
    expect(verdict.denial).toBeUndefined();
  });

  test("off skips the upstream read entirely", async () => {
    let fetched = false;
    const ctx = context({ base: OLDER });
    ctx.fetchStoredWorkflow = async () => {
      fetched = true;
      return null;
    };
    const verdict = await new StaleWriteMiddleware(options({ enforce: "off" })).evaluate(ctx);
    expect(verdict.block).toBe(false);
    expect(fetched).toBe(false);
  });

  describe("callers that declare no base", () => {
    test("are allowed by default", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(context());
      expect(verdict.block).toBe(false);
    });

    test("are refused under onMissingBase=deny", async () => {
      const verdict = await new StaleWriteMiddleware(options({ onMissingBase: "deny" })).evaluate(
        context(),
      );
      expect(verdict.block).toBe(true);
      expect(verdict.denial?.status).toBe(409);
      expect(verdict.denial?.message).toContain(BASE_UPDATED_AT_HEADER);
    });

    test("a blank header counts as absent", async () => {
      const verdict = await new StaleWriteMiddleware(options({ onMissingBase: "deny" })).evaluate(
        context({ base: "   " }),
      );
      expect(verdict.block).toBe(true);
    });
  });

  describe("scope", () => {
    test("ignores actions outside the configured list", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({ base: OLDER, action: "tags" }),
      );
      expect(verdict.block).toBe(false);
    });

    test("stays out of apply mode, which has its own conflict detection", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({ base: OLDER, mode: "apply" }),
      );
      expect(verdict.block).toBe(false);
    });

    test("passes when the route names no workflow", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({ base: OLDER, workflowId: "" }),
      );
      expect(verdict.block).toBe(false);
    });
  });

  describe("unreadable upstream state", () => {
    test("fails closed by default", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({ base: OLDER, storedError: new Error("boom") }),
      );
      expect(verdict.block).toBe(true);
      expect(verdict.denial?.message).toContain("boom");
    });

    test("fails open under onError=allow, with a warning", async () => {
      const verdict = await new StaleWriteMiddleware(options({ onError: "allow" })).evaluate(
        context({ base: OLDER, storedError: new Error("boom") }),
      );
      expect(verdict.block).toBe(false);
      expect(verdict.violations[0]?.severity).toBe("warning");
    });

    test("a host with no stored-workflow reader is an error, not a silent pass", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({ base: OLDER, omitFetcher: true }),
      );
      expect(verdict.block).toBe(true);
    });
  });

  describe("nothing to be stale against", () => {
    test("passes when the workflow does not exist upstream", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({ base: OLDER, stored: null }),
      );
      expect(verdict.block).toBe(false);
    });

    test("passes when upstream exposes no timestamp", async () => {
      const verdict = await new StaleWriteMiddleware(options()).evaluate(
        context({
          base: OLDER,
          stored: { id: "wf1", name: "x", active: false, nodes: [], connections: {} } as Workflow,
        }),
      );
      expect(verdict.block).toBe(false);
    });
  });
});

describe("staleWriteFactory", () => {
  test("defaults to off so adding it to a chain changes nothing on its own", () => {
    const mw = staleWriteFactory.build({});
    expect(mw.name).toBe("stale-write");
    // enforce=off means even a mismatching write passes.
    return expect(mw.evaluate(context({ base: OLDER }))).resolves.toMatchObject({ block: false });
  });

  test("reads config from env", () => {
    const partial = staleWriteFactory.loadFromEnv({
      N8N_STALE_WRITE_ENFORCE: "error",
      N8N_STALE_WRITE_ON_MISSING_BASE: "deny",
      N8N_STALE_WRITE_ON_ERROR: "allow",
      N8N_STALE_WRITE_ACTIONS: "update, tags",
    } as NodeJS.ProcessEnv);
    expect(partial).toEqual({
      enforce: "error",
      onMissingBase: "deny",
      onError: "allow",
      actions: ["update", "tags"],
    });
  });

  test("CLI flags override env", () => {
    const merged = {
      ...staleWriteFactory.loadFromEnv({ N8N_STALE_WRITE_ENFORCE: "warn" } as NodeJS.ProcessEnv),
      ...staleWriteFactory.loadFromCLI({ staleWriteEnforce: "error" }),
    };
    expect(merged.enforce).toBe("error");
  });

  test("rejects an unknown enforcement level", () => {
    expect(() => staleWriteFactory.build({ enforce: "sometimes" })).toThrow();
  });
});
