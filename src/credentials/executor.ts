import path from "node:path";
import type { CredentialService } from "@/api/credential-service.ts";
import { isNotFoundError } from "@/api/errors.ts";
import type { Credential } from "@/api/types.ts";
import { findSecretRefs, resolveSecretRefs } from "@/secrets/registry.ts";
import type { SecretResolver } from "@/secrets/types.ts";
import { stampCredentialID } from "./local-file.ts";
import { scanCredentialDirectory } from "./scanner.ts";
import type {
  CredentialApplyOptions,
  CredentialApplyResult,
  CredentialDefinition,
  CredentialFile,
  CredentialOperation,
} from "./types.ts";
import { updateCredentialCounts } from "./types.ts";

/**
 * Applies local credential definitions to an n8n server.
 *
 * The asymmetry with workflow apply is worth stating plainly, because it drives
 * every decision here: credential values are write-only in the public API, so
 * there is no remote state to compare against. This executor therefore cannot
 * skip an unchanged credential the way `apply` skips an unchanged workflow — a
 * definition that carries `data` is always written. What it can do, and does,
 * is never write values it was not given: a definition with no `data` updates
 * only the name.
 */
export class CredentialApplyExecutor {
  constructor(
    private readonly credentialService: CredentialService,
    private readonly resolvers: SecretResolver[],
    private readonly opts: CredentialApplyOptions,
  ) {}

  async execute(): Promise<CredentialApplyResult> {
    const result: CredentialApplyResult = {
      operations: [],
      dryRun: this.opts.dryRun,
      createCount: 0,
      updateCount: 0,
      skipCount: 0,
      errorCount: 0,
      warningCount: 0,
    };

    const files = selectFiles(scanCredentialDirectory(this.opts.directory), this.opts.ids);
    if (files.length === 0) return result;

    // Loaded once, and only when something might actually be created. Skipped
    // entirely on a dry run, which is meant to stay cheap and work offline —
    // the same trade `apply` makes for its own duplicate check, and what lets
    // the report honestly claim it fetched nothing.
    const existingByName =
      !this.opts.dryRun && files.some((f) => f.definition && !f.definition.id)
        ? await this.loadExistingNames()
        : new Map<string, Credential>();

    for (const file of files) {
      result.operations.push(await this.applyFile(file, existingByName));
    }

    updateCredentialCounts(result);
    return result;
  }

  /** Applies one definition file. */
  private async applyFile(
    file: CredentialFile,
    existingByName: Map<string, Credential>,
  ): Promise<CredentialOperation> {
    const op: CredentialOperation = {
      file: file.path,
      operation: "error",
      credentialID: "",
      credentialName: "",
      credentialType: "",
      secretRefs: [],
    };

    if (file.error || !file.definition) {
      op.error = file.error ?? new Error("credential definition could not be read");
      return op;
    }

    const definition = file.definition;
    op.credentialID = definition.id ?? "";
    op.credentialName = definition.name;
    op.credentialType = definition.type;
    op.secretRefs = findSecretRefs(definition.data ?? {}, this.resolvers).map(({ path, ref }) => ({
      path,
      scheme: ref.scheme,
      raw: ref.raw,
    }));

    try {
      return definition.id
        ? await this.applyUpdate(file, definition, op)
        : await this.applyCreate(file, definition, op, existingByName);
    } catch (err) {
      op.operation = "error";
      op.error = err instanceof Error ? err : new Error(String(err));
      return op;
    }
  }

  /** Creates a credential and records its new ID in the local file. */
  private async applyCreate(
    file: CredentialFile,
    definition: CredentialDefinition,
    op: CredentialOperation,
    existingByName: Map<string, Credential>,
  ): Promise<CredentialOperation> {
    op.operation = "create";

    const clash = existingByName.get(definition.name);
    if (clash?.id) {
      op.duplicateOf = { id: clash.id, name: clash.name };
      if (!this.opts.force) {
        // Refusing rather than warning-and-creating: n8n allows duplicate
        // credential names, so creating one produces two credentials with the
        // same label and no way for a person to tell which their nodes use.
        // Adopting the existing ID instead would be worse — it would silently
        // overwrite a credential this file has never been connected to.
        op.operation = "error";
        op.error = new Error(
          `a credential named "${definition.name}" already exists upstream (id: ${clash.id}). ` +
            `Set \`id: ${clash.id}\` in ${path.basename(file.path)} to update it, ` +
            "or pass --force to create a second one.",
        );
        return op;
      }
    }

    if (this.opts.dryRun) return op;

    const created = await this.credentialService.createCredential({
      name: definition.name,
      type: definition.type,
      // Create requires a data object; an empty one makes a credential whose
      // values are filled in later in the UI, which beats refusing the file.
      data: (await this.resolveData(definition)) ?? {},
    });

    op.credentialID = created.id ?? "";
    if (created.id) stampCredentialID(file.path, created.id);
    return op;
  }

  /** Updates an existing credential in place. */
  private async applyUpdate(
    file: CredentialFile,
    definition: CredentialDefinition,
    op: CredentialOperation,
  ): Promise<CredentialOperation> {
    const id = definition.id!;

    // Confirm the target exists before writing. Without this, a definition
    // holding an ID from a different n8n instance produces a bare 404 whose
    // cause — right file, wrong server — is not obvious from the message.
    try {
      await this.credentialService.getCredential(id);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      op.operation = "error";
      op.error = new Error(
        `credential ${id} does not exist on this server. ` +
          `Remove the \`id\` from ${path.basename(file.path)} to create it instead.`,
      );
      return op;
    }

    op.operation = "update";
    if (this.opts.dryRun) return op;

    const data = await this.resolveData(definition);
    await this.credentialService.updateCredential(id, {
      name: definition.name,
      // `type` and `data` travel together: the API requires data whenever the
      // type changes, so a definition that withholds its values must also
      // withhold the type rather than risk a rejected — or worse, accepted and
      // value-clearing — request.
      ...(data ? { type: definition.type, data } : {}),
    });

    return op;
  }

  /**
   * Resolves the definition's secret references, or returns undefined when the
   * definition carries no values at all.
   *
   * `undefined` and `{}` mean different things upstream: an absent `data` key
   * leaves the stored values alone, while an empty object replaces them with
   * nothing. Only a definition that literally wrote `data: {}` gets the latter.
   */
  private async resolveData(
    definition: CredentialDefinition,
  ): Promise<Record<string, unknown> | undefined> {
    if (definition.data === undefined) return undefined;
    return (await resolveSecretRefs(definition.data, this.resolvers)) as Record<string, unknown>;
  }

  /** Indexes upstream credentials by name, for the create-time collision check. */
  private async loadExistingNames(): Promise<Map<string, Credential>> {
    const byName = new Map<string, Credential>();
    try {
      for (const credential of await this.credentialService.listAllCredentials()) {
        // First wins, so the reported ID is stable when the server already has
        // duplicates of its own.
        if (!byName.has(credential.name)) byName.set(credential.name, credential);
      }
    } catch (err) {
      // Degrade to no check rather than failing the run, matching how workflow
      // apply treats an unavailable duplicate listing.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `Warning: duplicate-name check skipped — could not list upstream credentials: ${message}`,
      );
    }
    return byName;
  }
}

/**
 * Narrows the scanned files to the requested IDs.
 *
 * A selector matches either the credential's ID or the file's basename without
 * extension, because a definition that has never been applied has no ID to name
 * it by.
 */
export function selectFiles(files: CredentialFile[], ids: string[]): CredentialFile[] {
  if (ids.length === 0) return files;
  const wanted = new Set(ids);

  return files.filter((file) => {
    if (file.definition?.id && wanted.has(file.definition.id)) return true;
    return wanted.has(path.basename(file.path, path.extname(file.path)));
  });
}
