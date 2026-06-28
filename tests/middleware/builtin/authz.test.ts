import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { authzFactory } from "@/middleware/builtin/authz/factory.ts";
import type { FetchLike } from "@/middleware/builtin/authz/groups-resolver.ts";
import { AuthzMiddleware } from "@/middleware/builtin/authz/middleware.ts";
import type { AuthzOptions } from "@/middleware/builtin/authz/types.ts";
import { WorkflowACLExtractor } from "@/middleware/builtin/authz/workflow-acl.ts";
import type { PreWriteContext } from "@/middleware/types.ts";

const baseOptions: AuthzOptions = {
  enforce: "error",
  onError: "deny",
  identity: { source: "none" },
  groups: {
    url: "http://example.invalid/groups",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"email": ${json:identity}}',
    extract: "$.groups[*].id",
    cacheTtlMs: 60_000,
    timeoutMs: 1_000,
  },
  workflow: { extract: "$.tags[*].name", stripPrefix: "owner:" },
};

function workflowWithTags(tags: string[]): Workflow {
  return {
    name: "wf",
    active: false,
    nodes: [],
    connections: {},
    tags: tags.map((t) => ({ name: t })),
  };
}

function fetchReturning(json: unknown, status = 200): FetchLike {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function ctxFor(workflow: Workflow, identity?: string): PreWriteContext {
  return { workflow, identity, mode: "proxy" };
}

describe("workflow-acl extractor", () => {
  test("extracts tag suffix after stripPrefix", () => {
    const ex = new WorkflowACLExtractor({ extract: "$.tags[*].name", stripPrefix: "owner:" });
    expect(ex.extract(workflowWithTags(["owner:eng", "production", "owner:ops"]))).toEqual([
      "eng",
      "ops",
    ]);
  });
  test("returns [] when workflow is null", () => {
    const ex = new WorkflowACLExtractor({ extract: "$.tags[*].name", stripPrefix: "owner:" });
    expect(ex.extract(null)).toEqual([]);
  });
  test("returns [] when no tag matches the prefix", () => {
    const ex = new WorkflowACLExtractor({ extract: "$.tags[*].name", stripPrefix: "owner:" });
    expect(ex.extract(workflowWithTags(["staging"]))).toEqual([]);
  });
  test("no stripPrefix → verbatim matches", () => {
    const ex = new WorkflowACLExtractor({ extract: "$.tags[*].name" });
    expect(ex.extract(workflowWithTags(["eng", "ops"]))).toEqual(["eng", "ops"]);
  });
});

describe("authz: allow path", () => {
  test("identity has overlap → block=false", async () => {
    const mw = new AuthzMiddleware(baseOptions, {
      fetch: fetchReturning({ groups: [{ id: "eng" }, { id: "ops" }] }),
    });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(false);
    expect(v.violations).toEqual([]);
  });
});

describe("authz: deny paths", () => {
  test("no overlap → block=true with 403", async () => {
    const mw = new AuthzMiddleware(baseOptions, {
      fetch: fetchReturning({ groups: [{ id: "ops" }] }),
    });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(true);
    expect(v.denial?.status).toBe(403);
    expect(v.denial?.error).toBe("workflow_authz_denied");
    expect(v.violations[0]?.rule).toBe("authz-denied");
  });

  test("missing identity → block with authz-missing-identity", async () => {
    const mw = new AuthzMiddleware(baseOptions, { fetch: fetchReturning({ groups: [] }) });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"])));
    expect(v.block).toBe(true);
    expect(v.violations[0]?.rule).toBe("authz-missing-identity");
  });

  test("workflow with no ACL tag → block with authz-no-acl", async () => {
    const mw = new AuthzMiddleware(baseOptions, { fetch: fetchReturning({ groups: [] }) });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["staging"]), "ryo@example.com"));
    expect(v.block).toBe(true);
    expect(v.violations[0]?.rule).toBe("authz-no-acl");
  });
});

describe("authz: failure semantics", () => {
  test("HTTP failure + onError=deny → block with authz-resolver-error", async () => {
    const failing: FetchLike = () => Promise.reject(new Error("network blew up"));
    const mw = new AuthzMiddleware(baseOptions, { fetch: failing });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(true);
    expect(v.violations[0]?.rule).toBe("authz-resolver-error");
  });

  test("HTTP failure + onError=allow → pass with warning", async () => {
    const failing: FetchLike = () => Promise.reject(new Error("network blew up"));
    const mw = new AuthzMiddleware({ ...baseOptions, onError: "allow" }, { fetch: failing });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(false);
    expect(v.violations[0]?.rule).toBe("authz-resolver-warning");
    expect(v.violations[0]?.severity).toBe("warning");
  });

  test("non-2xx HTTP response → block under onError=deny", async () => {
    const mw = new AuthzMiddleware(baseOptions, { fetch: fetchReturning({}, 500) });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(true);
    expect(v.violations[0]?.message).toMatch(/HTTP 500/);
  });
});

describe("authz: enforce=off and warn", () => {
  test("enforce=off → always pass with no calls", async () => {
    let called = false;
    const fetchSpy: FetchLike = () => {
      called = true;
      return fetchReturning({ groups: [{ id: "ops" }] })("", {});
    };
    const mw = new AuthzMiddleware({ ...baseOptions, enforce: "off" }, { fetch: fetchSpy });
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(false);
    expect(called).toBe(false);
  });

  test("enforce=warn produces violations but does not block", async () => {
    const mw = new AuthzMiddleware(
      { ...baseOptions, enforce: "warn" },
      { fetch: fetchReturning({ groups: [{ id: "ops" }] }) },
    );
    const v = await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(v.block).toBe(false);
    expect(v.violations[0]?.rule).toBe("authz-denied");
  });
});

describe("authz: template expansion + caching", () => {
  test("identity is interpolated into request body via ${json:identity}", async () => {
    let capturedBody: string | undefined;
    const spy: FetchLike = (_url, init) => {
      capturedBody = init?.body as string | undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ groups: [{ id: "eng" }] }), { status: 200 }),
      );
    };
    const mw = new AuthzMiddleware(baseOptions, { fetch: spy });
    await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(capturedBody).toBe('{"email": "ryo@example.com"}');
  });

  test("identity → groups is cached across calls within TTL", async () => {
    let calls = 0;
    const spy: FetchLike = () => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ groups: [{ id: "eng" }] }), { status: 200 }),
      );
    };
    const mw = new AuthzMiddleware(baseOptions, { fetch: spy });
    await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    await mw.evaluate(ctxFor(workflowWithTags(["owner:eng"]), "ryo@example.com"));
    expect(calls).toBe(1);
  });
});

describe("authz: factory rejects missing required fields", () => {
  test("missing groups.url throws", () => {
    expect(() =>
      authzFactory.build({
        groups: { extract: "$.groups[*].id" },
        workflow: { extract: "$.tags[*].name" },
      }),
    ).toThrow();
  });

  test("missing groups.extract throws (no built-in response-shape assumption)", () => {
    expect(() =>
      authzFactory.build({
        groups: { url: "http://x.invalid/g" },
        workflow: { extract: "$.tags[*].name" },
      }),
    ).toThrow(/groups\.extract is required/);
  });

  test("missing workflow.extract throws (no built-in tag-convention assumption)", () => {
    expect(() =>
      authzFactory.build({
        groups: { url: "http://x.invalid/g", extract: "$.groups[*].id" },
        workflow: {},
      }),
    ).toThrow(/workflow\.extract is required/);
  });

  test("complete config is accepted", () => {
    expect(() =>
      authzFactory.build({
        groups: { url: "http://x.invalid/g", extract: "$.groups[*].id" },
        workflow: { extract: "$.tags[*].name" },
      }),
    ).not.toThrow();
  });
});
