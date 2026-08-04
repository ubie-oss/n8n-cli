import { apiKeyInjectFactory } from "./builtin/api-key-inject/factory.ts";
import { iapAuthFactory } from "./builtin/iap-auth/factory.ts";
import { impersonatorTokenFactory } from "./builtin/impersonator-token/factory.ts";
import { webhookTokenInjectFactory } from "./builtin/webhook-token-inject/factory.ts";
import { knownClientMiddlewareNames, registerClientFactory } from "./client-registry.ts";

/**
 * Registers every built-in client-middleware factory. Called once at process
 * startup from the CLI entry point. Idempotent: re-registration replaces
 * the previous factory under the same name, so tests can override builtins
 * by re-registering after `resetClientRegistry()` if needed.
 */
export function registerClientBuiltins(): void {
  registerClientFactory(iapAuthFactory);
  registerClientFactory(apiKeyInjectFactory);
  registerClientFactory(impersonatorTokenFactory);
  registerClientFactory(webhookTokenInjectFactory);
}

/**
 * Default client-middleware chain when neither --client-middleware nor
 * N8N_CLIENT_MIDDLEWARES is provided. Empty — client middlewares are
 * opt-in; deployments without IAP / shared API key don't need any.
 */
export const DEFAULT_CLIENT_MIDDLEWARE_CHAIN: string[] = [];

export { knownClientMiddlewareNames };
