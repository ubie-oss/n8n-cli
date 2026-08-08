/**
 * A credential as it is written in a local definition file.
 *
 * The shape mirrors the API's credential resource with one asymmetry that
 * shapes everything else in this module: `data` can be written but never read.
 * The public API marks credential data write-only and returns it from no
 * endpoint, so a local definition is the *only* record of what the values are —
 * there is nothing upstream to diff against, and `import` can never reconstruct
 * one.
 */
export interface CredentialDefinition {
  /** Server ID, absent until the credential has been created once. */
  id?: string;
  name: string;
  /** n8n credential type name, e.g. `slackApi`. */
  type: string;
  /**
   * Credential values, possibly written as secret references
   * (`gcp-sm://…`, `env://…`) which are resolved at apply time.
   *
   * Absent means "do not touch the stored values" on an update — which is what
   * a definition imported from a server looks like, since the server would not
   * tell it what the values are.
   */
  data?: Record<string, unknown>;
}

/** OperationType is the action apply took, or would take, on one file. */
export type CredentialOperationType = "create" | "update" | "skip" | "error";

/** CredentialApplyOptions configures `credential apply`. */
export interface CredentialApplyOptions {
  directory: string;
  dryRun: boolean;
  /**
   * When true, apply proceeds even though a credential being created shares its
   * name with one that already exists upstream.
   *
   * The check cannot be as strong as the workflow one: names are not unique in
   * n8n and the API will happily create a second credential with the same name,
   * which is a very easy way to end up with half a project pointing at a stale
   * copy. So a collision is a warning that fails the run unless waved through.
   */
  force: boolean;
  /** Restrict the run to these credential IDs or file basenames. */
  ids: string[];
}

/** Returns CredentialApplyOptions with default values. */
export function defaultCredentialApplyOptions(): CredentialApplyOptions {
  return {
    directory: "./credentials",
    dryRun: false,
    force: false,
    ids: [],
  };
}

/** One planned or executed action on a single credential file. */
export interface CredentialOperation {
  file: string;
  operation: CredentialOperationType;
  credentialID: string;
  credentialName: string;
  credentialType: string;
  /**
   * Field paths inside `data` that hold secret references, with the scheme that
   * would resolve each.
   *
   * Recorded so a dry run can say what it *would* fetch. The values themselves
   * are never stored on an operation — an ApplyResult is printed, and printing
   * a resolved secret to a CI log is the failure this module exists to avoid.
   */
  secretRefs: Array<{ path: string; scheme: string; raw: string }>;
  error?: Error;
  /** Name collision with an existing upstream credential, for creates. */
  duplicateOf?: { id: string; name: string };
}

/** Aggregated result of a credential apply run. */
export interface CredentialApplyResult {
  operations: CredentialOperation[];
  dryRun: boolean;
  createCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  warningCount: number;
}

/** Recalculates summary counts from operations. */
export function updateCredentialCounts(result: CredentialApplyResult): void {
  result.createCount = 0;
  result.updateCount = 0;
  result.skipCount = 0;
  result.errorCount = 0;
  result.warningCount = 0;

  for (const op of result.operations) {
    switch (op.operation) {
      case "create":
        result.createCount++;
        break;
      case "update":
        result.updateCount++;
        break;
      case "skip":
        result.skipCount++;
        break;
      case "error":
        result.errorCount++;
        break;
    }
    if (op.duplicateOf) result.warningCount++;
  }
}

/** A credential definition file found on disk. */
export interface CredentialFile {
  path: string;
  definition?: CredentialDefinition;
  error?: Error;
}
