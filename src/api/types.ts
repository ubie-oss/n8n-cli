/** Workflow represents an n8n workflow */
export interface Workflow {
  id?: string;
  name: string;
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
  nodes: Node[];
  connections: Record<string, NodeConn>;
  settings?: WorkflowSettings;
  staticData?: unknown;
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
