/** OperationType represents the type of import operation. */
export type OperationType = "create" | "update" | "skip" | "error" | "cleanup" | "match" | "rename";

/** SourceType indicates the format of the source file. */
export type SourceType = "json" | "yaml";

/** ImportOptions configures the import command behavior. */
export interface ImportOptions {
  directory: string;
  dryRun: boolean;
  includeArchived: boolean;
  yamlEnabled: boolean;
  externalizeThreshold: number;
  cleanupOrphans: boolean;
  cleanupSubfiles: boolean;
  ids: string[];
  filterByTags: string[];
}

/** Returns default import options. */
export function defaultImportOptions(): ImportOptions {
  return {
    directory: "./definitions",
    dryRun: false,
    includeArchived: false,
    yamlEnabled: false,
    externalizeThreshold: 3,
    cleanupOrphans: false,
    cleanupSubfiles: false,
    ids: [],
    filterByTags: [],
  };
}

/** ImportOperation represents a single workflow import action. */
export interface ImportOperation {
  workflowID: string;
  workflowName: string;
  type: OperationType;
  localPath: string;
  reason: string;
  oldPath?: string;
}

/** ImportResult aggregates all import operations. */
export class ImportResult {
  operations: ImportOperation[] = [];
  created = 0;
  updated = 0;
  skipped = 0;
  errors = 0;
  totalRemote = 0;
  durationMs = 0;
  matched = 0;
  cleanedUp = 0;
  renamed = 0;
  orphans: string[] = [];

  hasErrors(): boolean {
    return this.errors > 0;
  }

  hasChanges(): boolean {
    return this.created > 0 || this.updated > 0;
  }

  addOperation(op: ImportOperation): void {
    this.operations.push(op);
    switch (op.type) {
      case "create":
        this.created++;
        break;
      case "update":
        this.updated++;
        break;
      case "skip":
        this.skipped++;
        break;
      case "error":
        this.errors++;
        break;
      case "cleanup":
        this.cleanedUp++;
        break;
      case "match":
        this.matched++;
        break;
      case "rename":
        this.renamed++;
        break;
    }
  }
}

/** WorkflowIDMap maps workflow IDs to local file paths. */
export class WorkflowIDMap {
  private entries = new Map<string, string>();
  private _duplicates = new Map<string, string[]>();

  add(id: string, filePath: string): void {
    if (!id) return;
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      if (!this._duplicates.has(id)) {
        this._duplicates.set(id, [existing]);
      }
      this._duplicates.get(id)?.push(filePath);
    } else {
      this.entries.set(id, filePath);
    }
  }

  get(id: string): [string, boolean] {
    const p = this.entries.get(id);
    if (p !== undefined) return [p, true];
    return ["", false];
  }

  hasDuplicates(): boolean {
    return this._duplicates.size > 0;
  }

  duplicates(): Map<string, string[]> {
    return this._duplicates;
  }

  count(): number {
    return this.entries.size;
  }
}

/** OrphanFile represents a local workflow file without an ID. */
export interface OrphanFile {
  path: string;
  name: string;
  sourceType: SourceType;
}

/** OrphanFileMap indexes orphan files by workflow name. */
export class OrphanFileMap {
  private entries = new Map<string, OrphanFile[]>();

  add(orphan: OrphanFile): void {
    if (!orphan.name) return;
    const existing = this.entries.get(orphan.name) ?? [];
    existing.push(orphan);
    this.entries.set(orphan.name, existing);
  }

  getByName(name: string): OrphanFile[] {
    return this.entries.get(name) ?? [];
  }

  count(): number {
    let total = 0;
    for (const files of this.entries.values()) {
      total += files.length;
    }
    return total;
  }

  all(): OrphanFile[] {
    const result: OrphanFile[] = [];
    for (const files of this.entries.values()) {
      result.push(...files);
    }
    return result;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  remove(filePath: string): boolean {
    for (const [name, files] of this.entries) {
      const idx = files.findIndex((f) => f.path === filePath);
      if (idx !== -1) {
        files.splice(idx, 1);
        if (files.length === 0) {
          this.entries.delete(name);
        }
        return true;
      }
    }
    return false;
  }
}

/** ProgressCallback is called to report import progress. */
export type ProgressCallback = (
  current: number,
  total: number,
  workflowName: string,
  operation: OperationType,
) => void;
