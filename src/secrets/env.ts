import { type SecretRef, SecretResolveError, type SecretResolver } from "./types.ts";

/** Scheme claimed by this resolver. */
export const ENV_SCHEME = "env";

/**
 * Resolves `env://NAME` references from the process environment.
 *
 * Not a secret store, and not pretending to be one: it exists so a credential
 * definition can be applied in an environment that already injects its secrets
 * as variables — a CI job with repository secrets, a container with a mounted
 * config — without that definition having to name a cloud provider. It is also
 * the resolver that makes the whole reference mechanism testable without
 * network access.
 *
 * Only `process.env` is read. `.env` files are deliberately not loaded: this
 * project leaves that to direnv, and a CLI that quietly read dotfiles would
 * make it much harder to reason about which secret was applied.
 */
export class EnvSecretResolver implements SecretResolver {
  readonly scheme = ENV_SCHEME;
  readonly description = "process environment variables";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: SecretRef): Promise<string> {
    const name = ref.locator.trim();
    if (!name || name.includes("/")) {
      throw new SecretResolveError(ref, `expected ${ENV_SCHEME}://<VARIABLE_NAME>`);
    }

    const value = this.env[name];
    if (value === undefined) {
      throw new SecretResolveError(ref, `environment variable ${name} is not set`);
    }
    // An empty variable is almost always an unset one that something exported
    // anyway; applying it would overwrite a working credential with nothing.
    if (value === "") {
      throw new SecretResolveError(ref, `environment variable ${name} is empty`);
    }

    return value;
  }
}
