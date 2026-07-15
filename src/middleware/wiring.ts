import { authzFactory } from "./builtin/authz/factory.ts";
import { impersonatorVerifyFactory } from "./builtin/impersonator-verify/factory.ts";
import { lintFactory } from "./builtin/lint/factory.ts";
import { oauthVerifyFactory } from "./builtin/oauth-verify/factory.ts";
import { knownMiddlewareNames, registerFactory } from "./registry.ts";

/**
 * Registers every built-in middleware factory. Called once at process
 * startup from the CLI entry point. Idempotent: re-registration replaces
 * the previous factory under the same name, so tests can override
 * builtins by re-registering after `resetRegistry()` if needed.
 */
export function registerBuiltins(): void {
  registerFactory(lintFactory);
  registerFactory(authzFactory);
  registerFactory(oauthVerifyFactory);
  registerFactory(impersonatorVerifyFactory);
}

/**
 * Default server-middleware chain when neither --server-middleware nor
 * N8N_SERVER_MIDDLEWARES is provided. Lint-only preserves backwards
 * compatibility: every command that used to run a lint check still runs
 * exactly the same one.
 */
export const DEFAULT_SERVER_MIDDLEWARE_CHAIN = ["lint"];

export { knownMiddlewareNames };
