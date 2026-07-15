/**
 * Contract for producing a user-owned id_token that the client
 * middleware attaches as the impersonator side-header. Implementations
 * decide where the token comes from — a filesystem-backed OAuth
 * refresh grant, an in-memory pre-minted token, an environment
 * variable, whatever the deployment can produce a signed token from.
 *
 * The middleware itself doesn't care which implementation you use; only
 * the header format (a bare id_token string) is shared.
 */
export interface UserTokenSource {
  /** Returns a possibly-cached id_token whose `aud` claim equals `audience`. */
  getToken(audience: string): Promise<string>;
}

/** Static token — used by tests and pre-minted-token setups. */
export class StaticUserTokenSource implements UserTokenSource {
  constructor(private readonly token: string) {}
  getToken(_audience: string): Promise<string> {
    return Promise.resolve(this.token);
  }
}

/** Reads a pre-minted id_token from an env var. */
export class EnvUserTokenSource implements UserTokenSource {
  constructor(
    private readonly varName: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  getToken(_audience: string): Promise<string> {
    const value = this.env[this.varName];
    if (!value) {
      return Promise.reject(
        new Error(`impersonator-token: env var ${this.varName} is not set or empty`),
      );
    }
    return Promise.resolve(value);
  }
}
