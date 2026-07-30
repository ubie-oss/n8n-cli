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
  /**
   * Audience to use when the operator didn't configure one, if the source can
   * derive it from its own credentials.
   *
   * This matters because the `aud` of a token minted through the refresh-token
   * grant is not a free choice: Google only issues one for a client in the
   * same project as the credentials. Making the source name its own audience
   * removes a whole failure class where a configured constant silently doesn't
   * match the credentials in use (the request is then rejected downstream, or
   * the grant fails outright with `invalid_audience`).
   *
   * Return undefined when the source has no opinion.
   */
  defaultAudience?(): Promise<string | undefined>;
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
