import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { buildGroupsAuthenticator } from "@/middleware/builtin/authz/groups-auth.ts";
import { AuthzMiddleware } from "@/middleware/builtin/authz/middleware.ts";
import type { AuthzOptions } from "@/middleware/builtin/authz/types.ts";
import type { ServerMiddlewareContext } from "@/middleware/types.ts";

/**
 * Authorization against the *stored* ACL, plus the missing-ACL policies.
 *
 * The distinction matters because an ACL read out of the request body is not an
 * ACL: the caller writes that body. It matters practically too — n8n assigns
 * tags through a separate endpoint, so a workflow write payload never carries
 * them, and a tag-based ACL read from the body is always empty.
 */

const OPTIONS: AuthzOptions = {
  enforce: "error",
  onError: "deny",
  identity: { source: "none", decode: "raw" },
  groups: {
    url: "https://groups.test/lookup",
    method: "POST",
    headers: {},
    extract: "$.groups[*]",
    cacheTtlMs: 0,
    timeoutMs: 1000,
  },
  workflow: { extract: "$.tags[*].name", stripPrefix: "acl:" },
  aclSource: "upstream",
};

function withTags(...tags: string[]): Workflow {
  return {
    id: "wf1",
    name: "wf",
    nodes: [],
    connections: {},
    tags: tags.map((name) => ({ name })),
  } as unknown as Workflow;
}

function middleware(opts: Partial<AuthzOptions>, groups: string[]) {
  return new AuthzMiddleware(
    { ...OPTIONS, ...opts },
    {
      fetch: async () => new Response(JSON.stringify({ groups }), { status: 200 }),
    },
  );
}

function ctx(over: Partial<ServerMiddlewareContext> = {}): ServerMiddlewareContext {
  return {
    workflow: null,
    mode: "proxy",
    identity: "dev@example.com",
    action: "update",
    workflowId: "wf1",
    ...over,
  };
}

describe("authz: ACL from stored state", () => {
  test("allows when the stored ACL intersects the caller's groups", async () => {
    const mw = middleware({}, ["team-a", "everyone"]);

    const verdict = await mw.evaluate(
      ctx({ fetchStoredWorkflow: async () => withTags("managed", "acl:team-a") }),
    );

    expect(verdict.block).toBe(false);
  });

  test("denies when it does not", async () => {
    const mw = middleware({}, ["team-b"]);

    const verdict = await mw.evaluate(
      ctx({ fetchStoredWorkflow: async () => withTags("acl:team-a") }),
    );

    expect(verdict.block).toBe(true);
    expect(verdict.denial?.status).toBe(403);
    expect(verdict.violations[0]?.rule).toBe("authz-denied");
  });

  test("a self-granting body cannot buy access — only stored tags count", async () => {
    const mw = middleware({}, ["team-b"]);

    const verdict = await mw.evaluate(
      ctx({
        // Caller claims their own group in the payload...
        workflow: withTags("acl:team-b"),
        // ...but the stored workflow says otherwise.
        fetchStoredWorkflow: async () => withTags("acl:team-a"),
      }),
    );

    expect(verdict.block).toBe(true);
  });

  test("reads the stored workflow once per id, not once per check", async () => {
    let reads = 0;
    const mw = middleware({ aclCacheTtlMs: 60_000 }, ["team-a"]);
    const fetchStoredWorkflow = async () => {
      reads++;
      return withTags("acl:team-a");
    };

    await mw.evaluate(ctx({ fetchStoredWorkflow }));
    await mw.evaluate(ctx({ fetchStoredWorkflow }));

    expect(reads).toBe(1);
  });

  test("an unreachable upstream denies rather than reading as 'no ACL'", async () => {
    const mw = middleware({}, ["team-a"]);

    const verdict = await mw.evaluate(
      ctx({
        fetchStoredWorkflow: async () => {
          throw new Error("upstream returned HTTP 500 for workflow wf1");
        },
      }),
    );

    expect(verdict.block).toBe(true);
    expect(verdict.violations[0]?.rule).toBe("authz-acl-error");
  });

  test("onError=allow turns an unreachable upstream into a warning", async () => {
    const mw = middleware({ onError: "allow" }, ["team-a"]);

    const verdict = await mw.evaluate(
      ctx({
        fetchStoredWorkflow: async () => {
          throw new Error("boom");
        },
      }),
    );

    expect(verdict.block).toBe(false);
    expect(verdict.violations[0]?.severity).toBe("warning");
  });

  test("a host that cannot read upstream state is a configuration error, not an allow", async () => {
    const mw = middleware({}, ["team-a"]);

    const verdict = await mw.evaluate(ctx({ fetchStoredWorkflow: undefined }));

    expect(verdict.block).toBe(true);
    expect(verdict.violations[0]?.message).toMatch(/stored-workflow reader/);
  });
});

describe("authz: targets with no ACL", () => {
  test("create is denied by default — there is nothing to authorize against", async () => {
    const mw = middleware({}, ["team-a"]);

    const verdict = await mw.evaluate(
      ctx({ action: "create", workflowId: undefined, fetchStoredWorkflow: async () => null }),
    );

    expect(verdict.block).toBe(true);
    expect(verdict.violations[0]?.rule).toBe("authz-no-acl");
  });

  test("bootstrapGroups decides creates by membership", async () => {
    const mw = middleware({ bootstrapGroups: ["engineers"] }, ["engineers"]);

    const verdict = await mw.evaluate(
      ctx({ action: "create", workflowId: undefined, fetchStoredWorkflow: async () => null }),
    );

    expect(verdict.block).toBe(false);
  });

  test("bootstrapGroups still refuses a non-member", async () => {
    const mw = middleware({ bootstrapGroups: ["engineers"] }, ["marketing"]);

    const verdict = await mw.evaluate(
      ctx({ action: "create", workflowId: undefined, fetchStoredWorkflow: async () => null }),
    );

    expect(verdict.block).toBe(true);
  });

  test("onMissingAcl=allow lets unlabelled targets through", async () => {
    const mw = middleware({ onMissingAcl: "allow" }, ["team-a"]);

    const verdict = await mw.evaluate(
      ctx({ fetchStoredWorkflow: async () => withTags("managed") }),
    );

    expect(verdict.block).toBe(false);
  });
});

describe("authz: action scoping", () => {
  test("only authorizes the listed actions", async () => {
    const mw = middleware({ actions: ["delete"] }, ["team-b"]);

    // "update" is out of scope, so it passes untouched even though the
    // caller's groups don't match the stored ACL.
    const update = await mw.evaluate(
      ctx({ action: "update", fetchStoredWorkflow: async () => withTags("acl:team-a") }),
    );
    expect(update.block).toBe(false);

    const del = await mw.evaluate(
      ctx({ action: "delete", fetchStoredWorkflow: async () => withTags("acl:team-a") }),
    );
    expect(del.block).toBe(true);
  });
});

describe("authz: groups request authentication", () => {
  test("bearer-env attaches the token from the environment", async () => {
    const auth = buildGroupsAuthenticator({ kind: "bearer-env", tokenEnvVar: "TOK" }, {
      TOK: "secret-token",
    } as NodeJS.ProcessEnv);
    const headers: Record<string, string> = {};

    await auth?.(headers);

    expect(headers.authorization).toBe("Bearer secret-token");
  });

  test("bearer-env says which variable is empty instead of silently sending nothing", async () => {
    const auth = buildGroupsAuthenticator(
      { kind: "bearer-env", tokenEnvVar: "TOK" },
      {} as NodeJS.ProcessEnv,
    );

    await expect(auth?.({})).rejects.toThrow(/TOK/);
  });

  test("kind=none keeps the header-only behaviour", () => {
    expect(buildGroupsAuthenticator({ kind: "none" })).toBeUndefined();
    expect(buildGroupsAuthenticator(undefined)).toBeUndefined();
  });

  test("gcp-id-token requires an audience", () => {
    expect(() => buildGroupsAuthenticator({ kind: "gcp-id-token" })).toThrow(/audience/);
  });

  test("gcp-id-token with adc-impersonate requires the target service account", () => {
    expect(() =>
      buildGroupsAuthenticator({
        kind: "gcp-id-token",
        audience: "aud",
        tokenSource: "adc-impersonate",
      }),
    ).toThrow(/impersonateServiceAccount/);
  });
});
