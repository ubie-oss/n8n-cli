import { describe, expect, test } from "bun:test";
import type { Workflow } from "@/api/types.ts";
import { workflowProjectId } from "@/common/project-id.ts";
import { ProjectRoleChecker } from "@/middleware/builtin/project-role/checker.ts";
import { mcpToolAccessLevel } from "@/middleware/builtin/project-role/mcp-tools.ts";
import { ProjectRoleMiddleware } from "@/middleware/builtin/project-role/middleware.ts";
import type { FetchLike } from "@/middleware/builtin/project-role/n8n-api.ts";
import {
  PROJECT_ROLE_EDITOR,
  PROJECT_ROLE_VIEWER,
  projectRoleSatisfies,
} from "@/middleware/builtin/project-role/roles.ts";
import type { ProjectRoleOptions } from "@/middleware/builtin/project-role/types.ts";
import type { ServerMiddlewareContext } from "@/middleware/types.ts";

const PROJECT = "proj-1";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: "wf",
    active: false,
    nodes: [],
    connections: {},
    shared: [{ role: "workflow:owner", projectId: PROJECT }],
    ...overrides,
  };
}

function options(overrides: Partial<ProjectRoleOptions> = {}): ProjectRoleOptions {
  return {
    enforce: "error",
    onError: "deny",
    onMissingProject: "deny",
    identity: { source: "header", name: "x-user-email", decode: "raw" },
    membersCacheTtlMs: 60_000,
    instanceRoleCacheTtlMs: 60_000,
    timeoutMs: 5_000,
    actions: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiFetch(
  members: Array<{ email: string; role: string }>,
  instanceUsers: Array<{ email: string; role: string }>,
): FetchLike {
  return (input) => {
    const url = String(input);
    if (url.includes("/projects/") && url.includes("/users")) {
      return Promise.resolve(
        jsonResponse({
          data: members.map((m, i) => ({ id: `u${i}`, email: m.email, role: m.role })),
        }),
      );
    }
    if (url.includes("/api/v1/users")) {
      return Promise.resolve(
        jsonResponse({
          data: instanceUsers.map((u, i) => ({ id: `iu${i}`, email: u.email, role: u.role })),
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

describe("project roles", () => {
  test("viewer satisfies read but not write", () => {
    expect(projectRoleSatisfies(PROJECT_ROLE_VIEWER, "read")).toBe(true);
    expect(projectRoleSatisfies(PROJECT_ROLE_VIEWER, "write")).toBe(false);
  });

  test("editor satisfies read and write", () => {
    expect(projectRoleSatisfies(PROJECT_ROLE_EDITOR, "read")).toBe(true);
    expect(projectRoleSatisfies(PROJECT_ROLE_EDITOR, "write")).toBe(true);
  });

  test("workflowProjectId prefers workflow:owner", () => {
    expect(
      workflowProjectId(
        workflow({
          shared: [
            { role: "workflow:editor", projectId: "other" },
            { role: "workflow:owner", projectId: PROJECT },
          ],
        }),
      ),
    ).toBe(PROJECT);
  });
});

describe("ProjectRoleChecker", () => {
  test("prefers an explicit host project over workflow metadata", () => {
    const checker = new ProjectRoleChecker(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([], []),
    });
    expect(
      checker.resolveProjectId({
        workflow: workflow(),
        mode: "proxy",
        projectId: "target-project",
      }),
    ).toBe("target-project");
  });

  test("allows editor on write", async () => {
    const checker = new ProjectRoleChecker(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([{ email: "editor@example.com", role: PROJECT_ROLE_EDITOR }], []),
    });
    const result = await checker.check({
      email: "editor@example.com",
      projectId: PROJECT,
      level: "write",
    });
    expect(result.allowed).toBe(true);
  });

  test("denies viewer on write", async () => {
    const checker = new ProjectRoleChecker(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([{ email: "viewer@example.com", role: PROJECT_ROLE_VIEWER }], []),
    });
    const result = await checker.check({
      email: "viewer@example.com",
      projectId: PROJECT,
      level: "write",
    });
    expect(result.allowed).toBe(false);
    expect(result.rule).toBe("project-role-denied");
  });

  test("allows viewer on read", async () => {
    const checker = new ProjectRoleChecker(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([{ email: "viewer@example.com", role: PROJECT_ROLE_VIEWER }], []),
    });
    const result = await checker.check({
      email: "viewer@example.com",
      projectId: PROJECT,
      level: "read",
    });
    expect(result.allowed).toBe(true);
  });

  test("denies user with no project membership", async () => {
    const checker = new ProjectRoleChecker(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([], []),
    });
    const result = await checker.check({
      email: "stranger@example.com",
      projectId: PROJECT,
      level: "read",
    });
    expect(result.allowed).toBe(false);
  });

  test("instance admin bypasses project membership", async () => {
    const checker = new ProjectRoleChecker(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([], [{ email: "admin@example.com", role: "global:admin" }]),
    });
    const result = await checker.check({
      email: "admin@example.com",
      projectId: PROJECT,
      level: "write",
    });
    expect(result.allowed).toBe(true);
    expect(result.rule).toBe("project-role-instance-admin");
  });
});

describe("ProjectRoleMiddleware", () => {
  function ctx(overrides: Partial<ServerMiddlewareContext> = {}): ServerMiddlewareContext {
    const headers = new Headers({ "x-user-email": "viewer@example.com" });
    return {
      workflow: workflow(),
      request: new Request("http://proxy/api/v1/workflows/wf1", { method: "PUT", headers }),
      mode: "proxy",
      action: "update",
      workflowId: "wf1",
      ...overrides,
    };
  }

  test("blocks viewer updating a workflow", async () => {
    const mw = new ProjectRoleMiddleware(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([{ email: "viewer@example.com", role: PROJECT_ROLE_VIEWER }], []),
    });
    const verdict = await mw.evaluate(ctx());
    expect(verdict.block).toBe(true);
    expect(verdict.denial?.error).toBe("workflow_project_role_denied");
  });

  test("passes editor updating a workflow", async () => {
    const mw = new ProjectRoleMiddleware(options(), {
      upstream: "http://n8n.invalid",
      fetch: apiFetch([{ email: "editor@example.com", role: PROJECT_ROLE_EDITOR }], []),
    });
    const verdict = await mw.evaluate(
      ctx({
        request: new Request("http://proxy/api/v1/workflows/wf1", {
          method: "PUT",
          headers: { "x-user-email": "editor@example.com" },
        }),
      }),
    );
    expect(verdict.block).toBe(false);
  });
});

describe("mcpToolAccessLevel", () => {
  test("classifies read and write MCP tools", () => {
    expect(mcpToolAccessLevel("get_workflow_details")).toBe("read");
    expect(mcpToolAccessLevel("execute_workflow")).toBe("write");
    expect(mcpToolAccessLevel("search_workflows")).toBeUndefined();
  });
});
