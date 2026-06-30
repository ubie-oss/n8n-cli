import { knownClientMiddlewareNames } from "./client-registry.ts";

/**
 * Registers every built-in client-middleware factory. Called once at process
 * startup from the CLI entry point. Idempotent: re-registration replaces
 * the previous factory under the same name, so tests can override builtins
 * by re-registering after `resetClientRegistry()` if needed.
 *
 * Currently a no-op — builtins (iap-auth, api-key-inject, ...) land in
 * follow-up commits and self-register here.
 */
export function registerClientBuiltins(): void {
  // Intentionally empty. See module doc above.
}

/**
 * Default client-middleware chain when neither --client-middleware nor
 * N8N_CLIENT_MIDDLEWARES is provided. Empty — client middlewares are
 * opt-in; deployments without IAP / shared API key don't need any.
 */
export const DEFAULT_CLIENT_MIDDLEWARE_CHAIN: string[] = [];

export { knownClientMiddlewareNames };
