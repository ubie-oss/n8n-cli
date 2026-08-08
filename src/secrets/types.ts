/**
 * A parsed secret reference: a placeholder written into a credential file in
 * place of the secret itself, resolved to a real value at apply time.
 *
 * Written as a URI — `gcp-sm://my-project/slack-bot-token` — rather than as an
 * interpolation like `${...}`. Credential values reach n8n verbatim and n8n's
 * own expression syntax already owns `{{ }}` and `=`; a scheme prefix cannot be
 * confused with either, and it makes "is this whole value a reference?" a
 * question with one answer.
 */
export interface SecretRef {
  /** Scheme before `://`, lowercased. */
  scheme: string;
  /** Everything after `://`, untouched. */
  locator: string;
  /** The original string, for error messages. */
  raw: string;
}

/** Resolves references of one scheme to their secret values. */
export interface SecretResolver {
  /** Scheme this resolver claims, without `://`. */
  readonly scheme: string;
  /** Describes where values come from, for `--dry-run` style output. */
  readonly description: string;
  resolve(ref: SecretRef): Promise<string>;
}

/**
 * Raised when a reference cannot be turned into a value.
 *
 * Carries the reference rather than the value, and no resolver ever puts a
 * retrieved secret into an error message — an apply failure is exactly the
 * moment output is most likely to end up in a CI log.
 */
export class SecretResolveError extends Error {
  constructor(
    readonly ref: SecretRef,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`could not resolve ${ref.raw}: ${message}`);
    this.name = "SecretResolveError";
  }
}
