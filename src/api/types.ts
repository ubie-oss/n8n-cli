/** Workflow represents an n8n workflow */
export interface Workflow {
  id?: string;
  name: string;
  /**
   * Free-text summary of what the workflow does, stored at the top level of the
   * workflow object (not in `settings`, and not the local `description.md` the
   * importer writes as documentation).
   *
   * It is what n8n's MCP server shows an agent in `search_workflows` results and
   * in `get_workflow_details`, so for a workflow reachable over MCP this text is
   * the tool description the model reads before deciding to call it. n8n
   * truncates it at 255 characters from v2.27.0.
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
   * Raw API field for the folder a workflow sits in. n8n declares it
   * `writeOnly`: create/update accept it, but GET responses never include it,
   * so this is only ever populated from a local file (or an MCP-sourced import)
   * and can never be read back through the REST API. `null` means the project
   * root, deliberately.
   */
  parentFolderId?: string | null;
  /**
   * Local-only folder declaration as a folder *path* (`"Reporting/Daily"`).
   * YAML files declare folders this way because folder IDs cannot be chosen at
   * creation time; `null` (or the string `"root"`) means the project root is
   * being managed deliberately, and an absent key means "leave the folder
   * untouched". apply resolves the path to an ID via the folders API.
   */
  folder?: string | null;
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
  /**
   * Whether n8n's instance-level MCP server may expose this workflow to a
   * connected client. Off by default: without it an MCP client can still see
   * the workflow in `search_workflows`, but `get_workflow_details` and
   * `execute_workflow` refuse it.
   *
   * n8n's public API dropped this on write until v2.17.0 (n8n-io/n8n#27914), so
   * against an older server it round-trips through import and is then silently
   * discarded by apply — the toggle has to be set in the UI there.
   */
  availableInMCP?: boolean;
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
  /**
   * Sent only when the local definition carries one. An n8n old enough to
   * validate the payload strictly rejects unknown properties, so a definition
   * that never had a description must not acquire an empty one on write.
   */
  description?: string;
  nodes: Node[];
  connections: Record<string, NodeConn>;
  settings?: WorkflowSettings;
  staticData?: unknown;
  /**
   * Folder to place the workflow in, sent only when the local definition
   * manages one (see `Workflow.parentFolderId`). n8n accepts it on create;
   * servers too old to know folders reject the unknown property, which the
   * apply executor treats as a signal to fall back to a create without it.
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

/** Folder represents an n8n workflow folder (enterprise feature). */
export interface Folder {
  id: string;
  name: string;
  /** ID of the parent folder, or null/absent when the folder sits at the project root. */
  parentFolderId?: string | null;
  /** Some folder list responses inline the parent instead of its bare ID. */
  parentFolder?: { id: string; name?: string } | null;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** ListFoldersResponse represents the response from listing folders. */
export interface ListFoldersResponse {
  count: number;
  data: Folder[];
}

/** FolderInput represents input for creating a folder. */
export interface FolderInput {
  name: string;
  parentFolderId?: string;
}

/** FolderUpdateInput represents input for updating (renaming/moving) a folder. */
export interface FolderUpdateInput {
  name?: string;
  parentFolderId?: string | null;
}
