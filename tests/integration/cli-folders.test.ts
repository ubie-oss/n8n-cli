import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerFactory } from "@/middleware/registry.ts";
import type { ServerMiddleware, ServerMiddlewareFactory } from "@/middleware/types.ts";
import { startIapGate } from "./helpers/iap-gate.ts";
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
 *
 * A fourth hop — IAP in front of the proxy — is required to catch the
 * production failure mode: REST import succeeding while MCP 403s because
 * `McpClient` skipped the CLI's egress chain. Without that front door the
 * proxy-inject test stays green even when MCP never authenticates.
 */

const MCP_TOKEN_VAR = "N8N_TEST_MCP_TOKEN";
const IAP_TOKEN = "iap-id-token";
const IAP_TOKEN_VAR = "TEST_IAP_ID_TOKEN";

/** CLI env for talking through the IAP gate. No MCP token — the proxy injects it. */
function cliIapEnv(): Record<string, string> {
  return {
    N8N_MCP_TOKEN: "",
    N8N_CLIENT_MIDDLEWARES: "iap-auth",
    N8N_IAP_AUTH_TOKEN_SOURCE: "env",
    N8N_IAP_AUTH_TOKEN_ENV_VAR: IAP_TOKEN_VAR,
    [IAP_TOKEN_VAR]: IAP_TOKEN,
    N8N_IAP_AUTH_HEADER_NAME: "proxy-authorization",
    N8N_IAP_AUTH_AUDIENCE: "https://example.com/gateway",
  };
}

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

describe("CLI → IAP → proxy → mock n8n: folder assignments via MCP", () => {
  function proxyInjectingMcp() {
    return {
      ...seed(),
      clientMiddlewares: ["bearer-token-inject"],
      clientMiddlewareCliOptions: {
        bearerTokenInjectRules: JSON.stringify([
          { pathPrefix: "/mcp-server/", tokenEnvVar: MCP_TOKEN_VAR },
        ]),
      },
      proxyEnv: { [MCP_TOKEN_VAR]: "mcp-secret" },
    };
  }

  test("the IAP front door rejects the CLI when egress middlewares are off", async () => {
    await withStack(proxyInjectingMcp(), async (stack) => {
      const gate = startIapGate({ upstream: stack.proxyUrl, token: IAP_TOKEN });
      try {
        const { exitCode, stderr } = await stack.runCli(
          ["workflow", "list"],
          { N8N_MCP_TOKEN: "" },
          { apiUrl: gate.url },
        );
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/403|Forbidden|Invalid IAP/i);
        expect(gate.captured.some((r) => r.hasIap)).toBe(false);
      } finally {
        await gate.stop();
      }
    });
  });

  test("CLI iap-auth + proxy MCP inject writes parentFolderId and folder on JSON import", async () => {
    const dir = tmpDir();
    try {
      await withStack(proxyInjectingMcp(), async (stack) => {
        const gate = startIapGate({ upstream: stack.proxyUrl, token: IAP_TOKEN });
        try {
          const { exitCode, stderr } = await stack.runCli(
            ["import", "-d", dir, "--no-yaml", "--no-ts", "--mcp", "--ids", "wf-a"],
            cliIapEnv(),
            { apiUrl: gate.url },
          );
          expect(exitCode).toBe(0);
          expect(stderr).not.toContain("folder information unavailable");

          const mcpAtGate = gate.captured.filter((r) => r.pathname === "/mcp-server/http");
          expect(mcpAtGate.length).toBeGreaterThan(0);
          expect(mcpAtGate.every((r) => r.hasIap)).toBe(true);
          // IAP-only: the CLI has not minted an impersonator header yet.
          expect(mcpAtGate.every((r) => r.hasImpersonator)).toBe(false);
          // Proxy mode: the CLI must not carry an MCP Authorization through IAP.
          expect(mcpAtGate.every((r) => r.authorization === undefined)).toBe(true);

          const mcpAtMock = stack.mock.captured.filter((r) => r.pathname === "/mcp-server/http");
          expect(mcpAtMock.length).toBeGreaterThan(0);
          for (const req of mcpAtMock) {
            expect(req.headers.authorization).toBe("Bearer mcp-secret");
            expect(req.headers["proxy-authorization"]).toBeUndefined();
          }

          const written = JSON.parse(
            fs.readFileSync(path.join(dir, "alpha__wf-a.json"), "utf-8"),
          ) as { parentFolderId?: string | null; folder?: string | null };
          expect(written.parentFolderId).toBe("fold-2");
          expect(written.folder).toBe("Reporting/Daily");
        } finally {
          await gate.stop();
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Stands in for impersonator-verify: any request carrying the CLI's
 * impersonator header is a verified human. Agents do not send that header.
 */
function impersonatorPresenceFactory(): ServerMiddlewareFactory<object> {
  return {
    name: "impersonator-presence",
    loadFromEnv: () => ({}),
    loadFromCLI: () => ({}),
    build: (): ServerMiddleware => ({
      name: "impersonator-presence",
      evaluate(ctx) {
        if (ctx.request?.headers.get("x-impersonator-id-token")) {
          ctx.auth = { effective: { email: "operator@example.com", layer: "impersonator" } };
        }
        return { block: false, violations: [] };
      },
    }),
  };
}

describe("CLI → IAP → gated proxy → mock n8n: operator folder reads", () => {
  const IMPERSONATOR_VAR = "TEST_IMPERSONATOR_TOKEN";

  function productionLikeProxy() {
    return {
      ...seed(),
      clientMiddlewares: ["bearer-token-inject"],
      clientMiddlewareCliOptions: {
        bearerTokenInjectRules: JSON.stringify([
          { pathPrefix: "/mcp-server/", tokenEnvVar: MCP_TOKEN_VAR },
        ]),
      },
      proxyEnv: { [MCP_TOKEN_VAR]: "mcp-secret" },
      middlewares: ["impersonator-presence"],
      mcp: {
        enforce: "error" as const,
        policy: {
          // Production agent allowlist: no get_workflow_details.
          allowTools: ["search_workflows", "execute_workflow", "get_workflow_entry"],
          denyTools: [],
          workflowTags: ["mcp"],
        },
        cacheTtlMs: 60_000,
      },
    };
  }

  function cliOperatorEnv(): Record<string, string> {
    return {
      ...cliIapEnv(),
      N8N_CLIENT_MIDDLEWARES: "iap-auth,impersonator-token",
      N8N_IMPERSONATOR_TOKEN_SOURCE: "env",
      N8N_IMPERSONATOR_TOKEN_ENV_VAR: IMPERSONATOR_VAR,
      N8N_IMPERSONATOR_TOKEN_AUDIENCE: "https://example.com/impersonator",
      [IMPERSONATOR_VAR]: "user-tok",
    };
  }

  test("agent MCP policy does not strip folder assignments from an impersonated import --mcp", async () => {
    registerFactory(impersonatorPresenceFactory());
    const dir = tmpDir();
    try {
      await withStack(productionLikeProxy(), async (stack) => {
        const gate = startIapGate({ upstream: stack.proxyUrl, token: IAP_TOKEN });
        try {
          const { exitCode, stderr } = await stack.runCli(
            ["import", "-d", dir, "--no-yaml", "--no-ts", "--mcp", "--ids", "wf-a"],
            cliOperatorEnv(),
            { apiUrl: gate.url },
          );
          expect(exitCode).toBe(0);
          expect(stderr).not.toContain("folder information unavailable");
          expect(stderr).not.toContain("Unknown tool");

          const mcpAtGate = gate.captured.filter((r) => r.pathname === "/mcp-server/http");
          expect(mcpAtGate.length).toBeGreaterThan(0);
          expect(mcpAtGate.every((r) => r.hasIap)).toBe(true);
          expect(mcpAtGate.every((r) => r.hasImpersonator)).toBe(true);

          const written = JSON.parse(
            fs.readFileSync(path.join(dir, "alpha__wf-a.json"), "utf-8"),
          ) as { parentFolderId?: string | null; folder?: string | null };
          // wf-a is not mcp-tagged. An agent search would omit it; the
          // operator path must still attach the assignment REST cannot report.
          expect(written.parentFolderId).toBe("fold-2");
          expect(written.folder).toBe("Reporting/Daily");
        } finally {
          await gate.stop();
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same gated proxy strips folder assignments when the CLI is not impersonated", async () => {
    registerFactory(impersonatorPresenceFactory());
    const dir = tmpDir();
    try {
      await withStack(productionLikeProxy(), async (stack) => {
        const gate = startIapGate({ upstream: stack.proxyUrl, token: IAP_TOKEN });
        try {
          const { exitCode, stderr } = await stack.runCli(
            ["import", "-d", dir, "--no-yaml", "--no-ts", "--mcp", "--ids", "wf-a"],
            cliIapEnv(),
            { apiUrl: gate.url },
          );
          expect(exitCode).toBe(0);
          // Search is on the allowlist so MCP itself succeeds; the agent
          // policy then omits untagged wf-a and refuses get_workflow_details.
          // That is silent — REST still writes the file — which is why this
          // used to ship as "import worked".
          expect(stderr).not.toMatch(/403|Invalid IAP/i);

          const mcpAtGate = gate.captured.filter((r) => r.pathname === "/mcp-server/http");
          expect(mcpAtGate.length).toBeGreaterThan(0);
          expect(mcpAtGate.every((r) => r.hasIap)).toBe(true);
          expect(mcpAtGate.every((r) => r.hasImpersonator)).toBe(false);

          const written = JSON.parse(
            fs.readFileSync(path.join(dir, "alpha__wf-a.json"), "utf-8"),
          ) as { parentFolderId?: string | null; folder?: string | null };
          expect(written.parentFolderId).toBeUndefined();
          expect(written.folder).toBeUndefined();
        } finally {
          await gate.stop();
        }
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
