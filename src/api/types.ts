/** Workflow represents an n8n workflow */
export interface Workflow {
  id?: string;
  name: string;
  /**
   * Free-text description shown next to the workflow in the n8n UI.
   *
   * A first-class field of the public API's workflow schema, readable on GET
   * and writable on POST/PUT — unlike the `description.md` that `import` writes
   * into `_subfiles/`, which is a local document n8n never sees.
   */
  description?: string;
  active: boolean;
  isArchived?: boolean;
  nodes: Node[];
  connections: Record<string, NodeConn>;
  settings?: WorkflowSettings;
  staticData?: unknown;
  pinData?: Record<string, PinDataItem[]>;
  tags?: Tag[];
  shared?: SharedProject[];
  createdAt?: string;
  updatedAt?: string;
  /**
   * Folder the workflow lives in, declared locally.
   *
   * Local-only: the public API takes `parentFolderId` as a write-only field and
   * does not report a workflow's folder back, so this is never populated from a
   * server response. A definition names its folder by path (`"Ops/Billing"`) and
   * `apply` resolves it against the target project — an ID would tie the file to
   * one instance, which is exactly what workflows-as-code is trying to avoid.
   */
  folderPath?: string;
  /**
   * Folder the workflow lives in, by ID. Takes precedence over `folderPath`
   * when both are present, for callers that already know the ID.
   */
  folderId?: string;
}

/** Node represents a node in a workflow */
export interface Node {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  webhookId?: string;
  // Error handling settings
  onError?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  // Other node settings
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
}

/** NodeConn represents connections from a node */
export interface NodeConn {
  main?: Connection[][];
  ai_languageModel?: Connection[][];
  ai_outputParser?: Connection[][];
  ai_tool?: Connection[][];
  ai_memory?: Connection[][];
}

/** Connection represents a connection between nodes */
export interface Connection {
  node: string;
  type: string;
  index: number;
}

/** WorkflowSettings represents workflow settings */
export interface WorkflowSettings {
  saveExecutionProgress?: boolean;
  saveManualExecutions?: boolean;
  saveDataErrorExecution?: string;
  saveDataSuccessExecution?: string;
  executionTimeout?: number;
  timezone?: string;
}

/** Tag represents a workflow tag */
export interface Tag {
  id?: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

/** SharedProject represents project sharing information for a workflow */
export interface SharedProject {
  role: string;
  workflowId?: string;
  projectId: string;
  project?: Project;
  createdAt?: string;
  updatedAt?: string;
}

/** Project represents an n8n project */
export interface Project {
  id: string;
  name: string;
  type?: string;
}

/** ListWorkflowsResponse represents the response from listing workflows */
export interface ListWorkflowsResponse {
  data: Workflow[];
  nextCursor?: string;
}

/** WorkflowInput represents input for creating/updating a workflow.
 * Note: pinData is intentionally excluded - the n8n API rejects it
 * as an additional property in PUT/POST requests. */
export interface WorkflowInput {
  name: string;
  /** See {@link Workflow.description}. Omitted entirely when not set locally. */
  description?: string;
  nodes: Node[];
  connections: Record<string, NodeConn>;
  settings?: WorkflowSettings;
  staticData?: unknown;
  /**
   * Folder to place the workflow in.
   *
   * The API distinguishes three cases and so must this type: a string moves the
   * workflow into that folder, `null` moves it to the project root, and an
   * absent key leaves it where it is. Sending `undefined` through
   * `JSON.stringify` drops the key, which is the "leave it alone" case — so the
   * default behaviour is the non-destructive one.
   */
  parentFolderId?: string | null;
}

/** ListTagsResponse represents the response from listing tags */
export interface ListTagsResponse {
  data: Tag[];
  nextCursor?: string;
}

/** PinDataItem represents a single pinned data item for a node */
export interface PinDataItem {
  json: Record<string, unknown>;
}

/** TagInput represents input for creating a tag */
export interface TagInput {
  name: string;
}

/** TagIDInput represents a tag reference by ID for updating workflow tags */
export interface TagIDInput {
  id: string;
}

/** TransferInput represents input for transferring a workflow to a project */
export interface TransferInput {
  destinationProjectId: string;
}

/** CLIConfig represents configuration loaded from CLAUDE.md */
export interface CLIConfig {
  defaultProjectId?: string;
  autoTags?: string[];
  externalizeThreshold?: number;
}

/**
 * Folder represents an n8n workflow folder inside a project.
 *
 * Folders are a licensed feature (`feat:folders`): an instance without the
 * entitlement answers every folder endpoint with 403, so callers must be
 * prepared for the whole resource to be absent rather than empty.
 */
export interface Folder {
  id: string;
  name: string;
  /** null or absent for a folder sitting at the project root. */
  parentFolderId?: string | null;
  /**
   * Ancestor chain, innermost last, returned only when the caller asks for it
   * via the `select` query parameter. Used to render a folder's full path
   * without walking the tree one request at a time.
   */
  parentFolder?: FolderRef | null;
  createdAt?: string;
  updatedAt?: string;
}

/** FolderRef is the abbreviated folder shape nested inside another folder. */
export interface FolderRef {
  id: string;
  name: string;
  parentFolderId?: string | null;
  parentFolder?: FolderRef | null;
}

/** ListFoldersResponse represents the response from listing folders */
export interface ListFoldersResponse {
  /** Total number of folders matching the query, not just this page. */
  count: number;
  data: Folder[];
}

/** FolderInput represents input for creating a folder */
export interface FolderInput {
  name: string;
  parentFolderId?: string;
}

/** FolderUpdateInput represents input for renaming or re-parenting a folder */
export interface FolderUpdateInput {
  name?: string;
  parentFolderId?: string;
}

/** Credential represents an n8n credential */
export interface Credential {
  id?: string;
  name: string;
  type: string;
  data?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** ListCredentialsResponse represents the response from listing credentials */
export interface ListCredentialsResponse {
  data: Credential[];
  nextCursor?: string;
}

/** CredentialInput represents input for creating/updating a credential */
export interface CredentialInput {
  name: string;
  type: string;
  data: Record<string, unknown>;
}

/** CredentialSchema represents the schema for a credential type */
export interface CredentialSchema {
  additionalProperties?: boolean;
  type?: string;
  properties?: Record<string, CredentialSchemaProperty>;
  required?: string[];
}

/** CredentialSchemaProperty represents a property in a credential schema */
export interface CredentialSchemaProperty {
  type?: string;
  default?: unknown;
}

/** DataTableColumnType represents the type of a data table column */
export type DataTableColumnType = "string" | "number" | "boolean" | "date" | "json";

/** DataTableColumn represents a column in a data table */
export interface DataTableColumn {
  id?: string;
  name: string;
  type: DataTableColumnType;
  index?: number;
}

/** DataTable represents an n8n data table */
export interface DataTable {
  id: string;
  name: string;
  columns: DataTableColumn[];
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** ListDataTablesResponse represents the response from listing data tables */
export interface ListDataTablesResponse {
  data: DataTable[];
  nextCursor?: string;
}

/** DataTableInput represents input for creating a data table */
export interface DataTableInput {
  name: string;
  columns: DataTableColumn[];
}

/** DataTableUpdateInput represents input for updating a data table */
export interface DataTableUpdateInput {
  name: string;
}

/** DataTableRow represents a row in a data table */
export interface DataTableRow {
  id: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** ListDataTableRowsResponse represents the response from listing data table rows */
export interface ListDataTableRowsResponse {
  data: DataTableRow[];
  nextCursor?: string;
}

/** DataTableFilterCondition represents a single filter condition */
export interface DataTableFilterCondition {
  columnName: string;
  condition: string;
  value: unknown;
}

/** DataTableFilter represents a filter for querying data table rows */
export interface DataTableFilter {
  type: "and" | "or";
  filters: DataTableFilterCondition[];
}

/** InsertRowsInput represents input for inserting rows */
export interface InsertRowsInput {
  data: Record<string, unknown>[];
  returnType?: "count" | "id" | "all";
}

/** UpdateRowsInput represents input for updating rows */
export interface UpdateRowsInput {
  filter: DataTableFilter;
  data: Record<string, unknown>;
  returnData?: boolean;
  dryRun?: boolean;
}

/** UpsertRowInput represents input for upserting rows */
export interface UpsertRowInput {
  filter: DataTableFilter;
  data: Record<string, unknown>;
  returnData?: boolean;
  dryRun?: boolean;
}
