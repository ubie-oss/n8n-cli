import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withStack } from "./helpers/stack.ts";
import { cleanWorkflow } from "./helpers/workflows.ts";

/**
 * Folder assignments end-to-end: CLI → proxy → mock n8n.
 *
 * The REST API cannot report which folder a workflow is in
 * (`parentFolderId` is write-only), so import needs the mock's MCP surface.
 * The scenarios here prove the three deployment shapes: the CLI holding an
 * MCP token, a proxy injecting one (the CLI has none), and no MCP at all.
 * Apply's folder moves ride the PATCH endpoint the same way.
 */

const MCP_TOKEN_VAR = "N8N_TEST_MCP_TOKEN";

function seed() {
  return {
    workflows: [
      cleanWorkflow({
        id: "wf-a",
        name: "Alpha",
        shared: [{ role: "workflow:owner", projectId: "p1" }],
      }),
    ],
    folders: {
      p1: [
        { id: "fold-1", name: "Reporting", parentFolderId: null, projectId: "p1" },
        { id: "fold-2", name: "Daily", parentFolderId: "fold-1", projectId: "p1" },
      ],
    },
    mcpToken: "mcp-secret",
    mcpFolderAssignments: { "wf-a": "fold-2" },
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "n8n-cli-it-folders-"));
}

describe("CLI → proxy → mock n8n: folder assignments via MCP", () => {
  test("a proxy-held MCP token is injected for /mcp-server/* — the CLI needs none", async () => {
    const dir = tmpDir();
    try {
      await withStack(
        {
          ...seed(),
          clientMiddlewares: ["bearer-token-inject"],
          clientMiddlewareCliOptions: {
            bearerTokenInjectRules: JSON.stringify([
              { pathPrefix: "/mcp-server/", tokenEnvVar: MCP_TOKEN_VAR },
            ]),
          },
          proxyEnv: { [MCP_TOKEN_VAR]: "mcp-secret" },
        },
        async (stack) => {
          // No N8N_MCP_TOKEN on the CLI side — the proxy is the token holder.
          const { exitCode, stderr } = await stack.runCli(
            ["import", "-d", dir, "--yaml", "--mcp"],
            { N8N_MCP_TOKEN: "" },
          );
          expect(exitCode).toBe(0);
          expect(stderr).not.toContain("folder information unavailable");

          const text = fs.readFileSync(path.join(dir, "alpha__wf-a.yaml"), "utf-8");
          expect(text).toContain("folder: Reporting/Daily");
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a CLI-held MCP token works directly (no injection configured)", async () => {
    const dir = tmpDir();
    try {
      await withStack(seed(), async (stack) => {
        const { exitCode } = await stack.runCli([
          "import",
          "-d",
          dir,
          "--yaml",
          "--mcp-token",
          "mcp-secret",
        ]);
        expect(exitCode).toBe(0);

        const text = fs.readFileSync(path.join(dir, "alpha__wf-a.yaml"), "utf-8");
        expect(text).toContain("folder: Reporting/Daily");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without any MCP token the import degrades: warning, no folder key", async () => {
    const dir = tmpDir();
    try {
      await withStack(seed(), async (stack) => {
        const { exitCode, stderr } = await stack.runCli(["import", "-d", dir, "--yaml", "--mcp"], {
          N8N_MCP_TOKEN: "",
        });
        // The import itself succeeds — folder info is an enhancement.
        expect(exitCode).toBe(0);
        expect(stderr).toContain("folder information unavailable");

        const text = fs.readFileSync(path.join(dir, "alpha__wf-a.yaml"), "utf-8");
        expect(text).not.toContain("folder:");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--mcp-strict fails the import when the MCP surface is unreachable", async () => {
    const dir = tmpDir();
    try {
      await withStack(seed(), async (stack) => {
        const { exitCode } = await stack.runCli(
          ["import", "-d", dir, "--yaml", "--mcp", "--mcp-strict"],
          { N8N_MCP_TOKEN: "" },
        );
        expect(exitCode).toBe(1);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI → proxy → mock n8n: apply folder moves", () => {
  test("a folder declaration PATCHes parentFolderId; the GET never echoes it", async () => {
    const dir = tmpDir();
    try {
      await withStack(seed(), async (stack) => {
        fs.writeFileSync(
          path.join(dir, "wf-a.yaml"),
          [
            "id: wf-a",
            "name: Alpha",
            "folder: Reporting/Daily",
            "active: false",
            "nodes: []",
            "connections: {}",
            "",
          ].join("\n"),
        );

        const { exitCode, stdout } = await stack.runCli([
          "apply",
          "-d",
          dir,
          "--yaml",
          "--ids",
          "wf-a",
          "--no-lint",
          "-p",
          "p1",
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("folder: Reporting/Daily");

        // The move rode the write-only PATCH endpoint...
        const patch = stack.mock
          .writes()
          .find((r) => r.method === "PATCH" && r.pathname === "/api/v1/workflows/wf-a");
        expect(patch).toBeDefined();
        const body = JSON.parse(patch!.body) as { parentFolderId?: string | null };
        expect(body.parentFolderId).toBe("fold-2");

        // ...and the write-only contract holds: a second identical apply
        // skips rather than updating forever (the folder move itself is
        // idempotent and still asserted).
        const second = await stack.runCli([
          "apply",
          "-d",
          dir,
          "--yaml",
          "--ids",
          "wf-a",
          "--no-lint",
          "-p",
          "p1",
        ]);
        expect(second.stdout).toContain("SKIP");
        expect(second.exitCode).toBe(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("folders.yaml is synced through the proxy before workflow processing", async () => {
    const dir = tmpDir();
    try {
      await withStack(
        {
          ...seed(),
          folders: { p1: [] }, // nothing exists yet upstream
          mcpFolderAssignments: {},
        },
        async (stack) => {
          fs.writeFileSync(
            path.join(dir, "folders.yaml"),
            "projects:\n  - projectId: p1\n    folders:\n      - name: Reporting\n        folders:\n          - name: Daily\n",
          );
          fs.writeFileSync(
            path.join(dir, "wf-a.yaml"),
            [
              "id: wf-a",
              "name: Alpha",
              "folder: Reporting/Daily",
              "active: false",
              "nodes: []",
              "connections: {}",
              "",
            ].join("\n"),
          );

          const { exitCode, stdout } = await stack.runCli([
            "apply",
            "-d",
            dir,
            "--yaml",
            "--ids",
            "wf-a",
            "--no-lint",
            "-p",
            "p1",
          ]);
          expect(exitCode).toBe(0);
          expect(stdout).toContain("FOLDERS (folders.yaml)");
          expect(stdout).toContain("+ Reporting/Daily");
          expect(stdout).toContain("-> folder: Reporting/Daily");

          // Both folders were created upstream, parent first.
          const creates = stack.mock
            .writes()
            .filter(
              (r) => r.method === "POST" && r.pathname.startsWith("/api/v1/projects/p1/folders"),
            );
          const names = creates.map((r) => (JSON.parse(r.body) as { name: string }).name);
          expect(names).toEqual(["Reporting", "Daily"]);
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
