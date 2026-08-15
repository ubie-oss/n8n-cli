import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workflow } from "@/api/types.ts";
import { withStack } from "./helpers/stack.ts";
import { brokenWorkflow, cleanWorkflow } from "./helpers/workflows.ts";

/**
 * CLI → proxy → mock n8n.
 *
 * Unit tests already cover the CLI against a mock, and the proxy against a
 * mock, separately. These scenarios wire the three together so a change in
 * either hop that breaks the contract the other hop relies on fails in CI.
 */

const STORED_AT = "2026-03-01T10:00:00.000Z";
const OLDER_AT = "2026-02-01T10:00:00.000Z";

describe("CLI → proxy → mock n8n: reads", () => {
  test("workflow list returns the workflows the mock seeded", async () => {
    await withStack(
      {
        workflows: [
          cleanWorkflow({ id: "wf-a", name: "Alpha" }),
          cleanWorkflow({ id: "wf-b", name: "Beta", active: true }),
        ],
      },
      async (stack) => {
        const { stdout, exitCode } = await stack.runCli(["workflow", "list"]);
        expect(exitCode).toBe(0);
        const listed = JSON.parse(stdout) as Workflow[];
        expect(listed.map((w) => w.id).sort()).toEqual(["wf-a", "wf-b"]);
        expect(listed.map((w) => w.name).sort()).toEqual(["Alpha", "Beta"]);
      },
    );
  });

  test("workflow list follows cursor pagination through the proxy", async () => {
    await withStack(
      {
        workflows: [
          cleanWorkflow({ id: "wf-1", name: "One" }),
          cleanWorkflow({ id: "wf-2", name: "Two" }),
          cleanWorkflow({ id: "wf-3", name: "Three" }),
        ],
        listPageSize: 2,
      },
      async (stack) => {
        const { stdout, exitCode } = await stack.runCli(["workflow", "list"]);
        expect(exitCode).toBe(0);
        const listed = JSON.parse(stdout) as Workflow[];
        expect(listed).toHaveLength(3);
        expect(stack.mock.captured.filter((r) => r.method === "GET")).toHaveLength(2);
      },
    );
  });

  test("workflow get returns a seeded workflow", async () => {
    await withStack(
      { workflows: [cleanWorkflow({ id: "wf-get", name: "Get Me" })] },
      async (stack) => {
        const { stdout, exitCode } = await stack.runCli(["workflow", "get", "wf-get"]);
        expect(exitCode).toBe(0);
        const wf = JSON.parse(stdout) as Workflow;
        expect(wf.id).toBe("wf-get");
        expect(wf.name).toBe("Get Me");
      },
    );
  });

  test("workflow get of a missing id exits 1 with a not-found error", async () => {
    await withStack({}, async (stack) => {
      const { stderr, exitCode } = await stack.runCli(["workflow", "get", "missing"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("not found");
    });
  });

  test("an upstream 500 is surfaced by the CLI", async () => {
    await withStack(
      {
        hook: (_req, url) => {
          if (url.pathname === "/api/v1/workflows" || url.pathname === "/api/v1/workflows/") {
            return new Response(JSON.stringify({ message: "upstream exploded" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          return null;
        },
      },
      async (stack) => {
        const { stderr, exitCode } = await stack.runCli(["workflow", "list"]);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/upstream exploded|Server error/i);
      },
    );
  });
});

describe("CLI → proxy → mock n8n: writes", () => {
  test("workflow create stores the definition on the mock", async () => {
    await withStack({}, async (stack) => {
      const tmp = tmpDir();
      const file = path.join(tmp, "new.json");
      fs.writeFileSync(file, JSON.stringify(cleanWorkflow({ name: "Created Via CLI" })));
      try {
        const { stdout, exitCode } = await stack.runCli(["workflow", "create", "-f", file]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Created Via CLI");
        const stored = [...stack.mock.workflows.values()];
        expect(stored).toHaveLength(1);
        expect(stored[0]?.name).toBe("Created Via CLI");
        expect(stack.mock.writes().some((r) => r.method === "POST")).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  test("apply updates a remote workflow through the proxy", async () => {
    const remote = cleanWorkflow({
      id: "wf-upd",
      name: "Before",
      updatedAt: STORED_AT,
      createdAt: STORED_AT,
    });
    await withStack({ workflows: [remote] }, async (stack) => {
      const tmp = tmpDir();
      fs.writeFileSync(
        path.join(tmp, "renamed__wf-upd.json"),
        JSON.stringify({ ...remote, name: "After" }),
      );
      try {
        const { stdout, exitCode } = await stack.runCli([
          "apply",
          "--dir",
          tmp,
          "--ids",
          "wf-upd",
          "--no-auto-tag",
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("UPDATE");
        expect(stack.mock.get("wf-upd")?.name).toBe("After");
        expect(stack.mock.writes().some((r) => r.method === "PUT")).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  test("import writes a remote workflow to disk through the proxy", async () => {
    await withStack(
      { workflows: [cleanWorkflow({ id: "wf-imp", name: "Imported" })] },
      async (stack) => {
        const tmp = tmpDir();
        try {
          const { exitCode } = await stack.runCli([
            "import",
            "--dir",
            tmp,
            "--ids",
            "wf-imp",
            "--no-yaml",
            "--no-ts",
          ]);
          expect(exitCode).toBe(0);
          const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".json"));
          expect(files.length).toBeGreaterThanOrEqual(1);
          const written = JSON.parse(
            fs.readFileSync(path.join(tmp, files[0]!), "utf8"),
          ) as Workflow;
          expect(written.id).toBe("wf-imp");
          expect(written.name).toBe("Imported");
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    );
  });

  test("workflow activate flips the stored flag", async () => {
    await withStack(
      { workflows: [cleanWorkflow({ id: "wf-act", name: "Act", active: false })] },
      async (stack) => {
        const { stdout, exitCode } = await stack.runCli(["workflow", "activate", "wf-act"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("is now active");
        expect(stack.mock.get("wf-act")?.active).toBe(true);
      },
    );
  });
});

describe("CLI → proxy → mock n8n: proxy lint is the backstop", () => {
  test("apply --no-lint of a broken workflow is still refused by the proxy", async () => {
    await withStack({ allowDuplicates: true }, async (stack) => {
      const tmp = tmpDir();
      fs.writeFileSync(path.join(tmp, "broken.json"), JSON.stringify(brokenWorkflow()));
      try {
        const { stdout, stderr, exitCode } = await stack.runCli([
          "apply",
          "--dir",
          tmp,
          "--dangerously-apply-all",
          "--no-lint",
          "--no-auto-tag",
        ]);
        expect(exitCode).toBe(1);
        expect(stdout + stderr).toMatch(/linter rule|connection-reference|workflow_lint_failed/i);
        expect(stack.mock.writes()).toHaveLength(0);
        expect(stack.mock.workflows.size).toBe(0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  test("workflow create --no-lint of a broken workflow is still refused by the proxy", async () => {
    await withStack({ allowDuplicates: true }, async (stack) => {
      const tmp = tmpDir();
      const file = path.join(tmp, "broken.json");
      fs.writeFileSync(file, JSON.stringify(brokenWorkflow()));
      try {
        const { stderr, exitCode } = await stack.runCli([
          "workflow",
          "create",
          "-f",
          file,
          "--no-lint",
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/linter rule|connection-reference|not forwarded/i);
        expect(stack.mock.writes()).toHaveLength(0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

describe("CLI → proxy → mock n8n: duplicate names", () => {
  test("creating a workflow whose name already exists is a 409", async () => {
    await withStack(
      {
        workflows: [cleanWorkflow({ id: "wf-dup", name: "Same Name" })],
        allowDuplicates: false,
        enforce: "error",
      },
      async (stack) => {
        const tmp = tmpDir();
        const file = path.join(tmp, "dup.json");
        fs.writeFileSync(file, JSON.stringify(cleanWorkflow({ name: "Same Name" })));
        try {
          const { stderr, exitCode } = await stack.runCli([
            "workflow",
            "create",
            "-f",
            file,
            "--no-lint",
          ]);
          expect(exitCode).toBe(1);
          expect(stderr).toMatch(/already exists|duplicate/i);
          expect(stack.mock.workflows.size).toBe(1);
          expect(stack.mock.writes()).toHaveLength(0);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    );
  });
});

describe("CLI → proxy → mock n8n: api-key-inject", () => {
  test("the CLI's key is replaced before the mock sees the request", async () => {
    const injectVar = `N8N_TEST_INJECT_${crypto.randomUUID().replace(/-/g, "")}`;
    await withStack(
      {
        workflows: [cleanWorkflow({ id: "wf-key", name: "Keyed" })],
        requiredApiKey: "upstream-secret",
        clientMiddlewares: ["api-key-inject"],
        clientMiddlewareCliOptions: { apiKeyInjectKeyEnvVar: injectVar },
        proxyEnv: { [injectVar]: "upstream-secret" },
      },
      async (stack) => {
        const { exitCode } = await stack.runCli(["workflow", "list"], {
          N8N_API_KEY: "cli-placeholder",
        });
        expect(exitCode).toBe(0);
        const forwarded = stack.mock.captured.find((r) => r.pathname.includes("/workflows"));
        expect(forwarded?.headers["x-n8n-api-key"]).toBe("upstream-secret");
      },
    );
  });

  test("without inject, a placeholder key is rejected by the mock", async () => {
    await withStack(
      {
        workflows: [cleanWorkflow({ id: "wf-key", name: "Keyed" })],
        requiredApiKey: "upstream-secret",
      },
      async (stack) => {
        const { stderr, exitCode } = await stack.runCli(["workflow", "list"], {
          N8N_API_KEY: "cli-placeholder",
        });
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/Authentication failed|Unauthorized/i);
      },
    );
  });
});

describe("CLI → proxy → mock n8n: stale-write", () => {
  test("apply --force of a stale checkout is refused and does not revert upstream", async () => {
    const remote = cleanWorkflow({
      id: "wf1",
      name: "Upstream Edit",
      updatedAt: STORED_AT,
      createdAt: STORED_AT,
    });
    await withStack(
      {
        workflows: [remote],
        allowDuplicates: true,
        middlewares: ["stale-write"],
        middlewareCliOptions: { staleWriteEnforce: "error" },
      },
      async (stack) => {
        const tmp = tmpDir();
        fs.writeFileSync(
          path.join(tmp, "stale__wf1.json"),
          JSON.stringify({ ...remote, name: "Would Revert", updatedAt: OLDER_AT }),
        );
        try {
          const { stdout, stderr, exitCode } = await stack.runCli([
            "apply",
            "--dir",
            tmp,
            "--ids",
            "wf1",
            "--force",
            "--no-auto-tag",
            "--no-lint",
          ]);
          expect(exitCode).toBe(1);
          expect(stdout + stderr).toMatch(/stale|never seen|based on/i);
          expect(stack.mock.get("wf1")?.name).toBe("Upstream Edit");
          expect(stack.mock.writes()).toHaveLength(0);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    );
  });
});

describe("CLI → proxy → mock n8n: authz", () => {
  test("a create with no ACL is refused and never reaches the mock", async () => {
    const groups = startGroupsServer();
    try {
      await withStack(
        {
          allowDuplicates: true,
          middlewares: ["authz"],
          middlewareCliOptions: {
            authzEnforce: "error",
            authzOnError: "deny",
            authzIdentitySource: "env",
            authzIdentityName: "TEST_ACTOR",
            authzIdentityDecode: "raw",
            authzGroupsUrl: `http://127.0.0.1:${groups.port}/groups`,
            authzGroupsMethod: "POST",
            authzGroupsHeaders: '{"content-type":"application/json"}',
            authzGroupsBody: '{"email": ${json:identity}}',
            authzGroupsExtract: "$.groups[*].id",
            authzWorkflowExtract: "$.tags[*].name",
            authzWorkflowStripPrefix: "owner:",
          },
          proxyEnv: { TEST_ACTOR: "alice@example.com" },
        },
        async (stack) => {
          const tmp = tmpDir();
          const file = path.join(tmp, "wf.json");
          fs.writeFileSync(file, JSON.stringify(cleanWorkflow({ name: "No ACL" })));
          try {
            const { stderr, exitCode } = await stack.runCli([
              "workflow",
              "create",
              "-f",
              file,
              "--no-lint",
            ]);
            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/not declare any allowed groups|authz|denied/i);
            expect(stack.mock.writes()).toHaveLength(0);
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        },
      );
    } finally {
      await groups.stop();
    }
  });
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-stack-"));
}

function startGroupsServer(): { port: number; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(JSON.stringify({ groups: [{ id: "eng" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    port: server.port!,
    stop: async () => {
      await server.stop(true);
    },
  };
}
