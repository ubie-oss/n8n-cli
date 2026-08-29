import { resolve } from "node:path";
import type { EnforceLevel } from "@/proxy/config.ts";
import type { McpGateSettings } from "@/proxy/mcp/config.ts";
import { type ProxyHandle, startProxy } from "@/proxy/server.ts";
import { type N8nMock, type N8nMockOptions, startN8nMock } from "./n8n-mock.ts";

const CLI_ENTRY = resolve("src/index.ts");

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Stack {
  mock: N8nMock;
  proxy: ProxyHandle;
  proxyUrl: string;
  runCli: (
    args: string[],
    env?: Record<string, string>,
    opts?: { apiUrl?: string },
  ) => Promise<CliResult>;
  stop: () => Promise<void>;
}

export interface StackOptions extends N8nMockOptions {
  enforce?: EnforceLevel;
  allowDuplicates?: boolean;
  middlewares?: string[];
  middlewareCliOptions?: Record<string, unknown>;
  clientMiddlewares?: string[];
  clientMiddlewareCliOptions?: Record<string, unknown>;
  /**
   * Extra env vars set on the *proxy process* (this test process) before
   * `startProxy`. Used for client-middleware secrets such as the injected
   * API key. Restored when the stack stops.
   */
  proxyEnv?: Record<string, string>;
  /** MCP gate policy. Absent = transparent `/mcp-server/` forward. */
  mcp?: McpGateSettings;
}

/**
 * Stands up mock n8n ← proxy, then runs the real CLI against the proxy URL.
 *
 * This is the integration seam the unit tests cannot see: CLI HTTP client →
 * proxy policy → upstream. Each call owns its own ports so tests can run
 * without sharing mutable server state.
 */
export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const previousEnv: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(opts.proxyEnv ?? {})) {
    previousEnv.push([key, process.env[key]]);
    process.env[key] = value;
  }

  const mock = startN8nMock(opts);
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({
      listen: "127.0.0.1:0",
      upstream: `http://127.0.0.1:${mock.port}`,
      enforce: opts.enforce ?? "error",
      disableRules: [],
      logFormat: "json",
      allowDuplicates: opts.allowDuplicates ?? true,
      ...(opts.middlewares ? { middlewares: opts.middlewares } : {}),
      ...(opts.middlewareCliOptions ? { middlewareCliOptions: opts.middlewareCliOptions } : {}),
      ...(opts.clientMiddlewares ? { clientMiddlewares: opts.clientMiddlewares } : {}),
      ...(opts.clientMiddlewareCliOptions
        ? { clientMiddlewareCliOptions: opts.clientMiddlewareCliOptions }
        : {}),
      ...(opts.mcp ? { mcp: opts.mcp } : {}),
    });
    await waitReady(proxy.port);
  } catch (err) {
    await proxy?.stop();
    await mock.stop();
    restoreEnv(previousEnv);
    throw err;
  }

  const proxyUrl = `http://127.0.0.1:${proxy.port}`;

  return {
    mock,
    proxy,
    proxyUrl,
    runCli: (args, env, opts) => runCli(opts?.apiUrl ?? proxyUrl, args, env),
    stop: async () => {
      await proxy.stop();
      await mock.stop();
      restoreEnv(previousEnv);
    },
  };
}

export async function withStack(
  opts: StackOptions,
  fn: (stack: Stack) => Promise<void>,
): Promise<void> {
  const stack = await startStack(opts);
  try {
    await fn(stack);
  } finally {
    await stack.stop();
  }
}

async function runCli(
  proxyUrl: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "--api-url", proxyUrl, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      N8N_API_URL: proxyUrl,
      N8N_API_KEY: "cli-key",
      N8N_CLI_DISABLE_UPDATE_CHECK: "1",
      // Keep the spawned CLI from inheriting this test process's middleware
      // env — those belong to the in-process proxy, not to `apply`'s own gate.
      N8N_SERVER_MIDDLEWARES: "",
      N8N_CLIENT_MIDDLEWARES: "",
      ...extraEnv,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      last = await res.text();
      if (res.status === 200) return;
      if (res.status === 503 && last.startsWith("not ready")) {
        throw new Error(`proxy failed readiness:\n${last}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("proxy failed")) throw err;
    }
    await Bun.sleep(25);
  }
  throw new Error(`proxy did not become ready in time: ${last}`);
}

function restoreEnv(previous: Array<[string, string | undefined]>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
