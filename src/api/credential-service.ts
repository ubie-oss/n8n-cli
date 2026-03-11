import type { Client } from "./client.ts";
import type {
  Credential,
  CredentialInput,
  CredentialSchema,
  ListCredentialsResponse,
  TransferInput,
} from "./types.ts";

/** ListCredentialsOptions represents options for listing credentials */
export interface ListCredentialsOptions {
  limit?: number;
  cursor?: string;
}

/** CredentialService handles credential API operations */
export class CredentialService {
  constructor(private readonly client: Client) {}

  /** ListCredentials lists all credentials with optional pagination */
  async listCredentials(opts?: ListCredentialsOptions): Promise<ListCredentialsResponse> {
    const params = new URLSearchParams();

    if (opts) {
      if (opts.limit && opts.limit > 0) {
        params.set("limit", String(opts.limit));
      }
      if (opts.cursor) {
        params.set("cursor", opts.cursor);
      }
    }

    const query = params.toString();
    const path = query ? `/credentials?${query}` : "/credentials";

    const data = await this.client.get(path);
    return JSON.parse(data) as ListCredentialsResponse;
  }

  /** ListAllCredentials lists all credentials with automatic pagination */
  async listAllCredentials(): Promise<Credential[]> {
    const allCredentials: Credential[] = [];
    const opts: ListCredentialsOptions = { limit: 250 };

    for (;;) {
      const resp = await this.listCredentials(opts);
      allCredentials.push(...resp.data);

      if (!resp.nextCursor) {
        break;
      }
      opts.cursor = resp.nextCursor;
    }

    return allCredentials;
  }

  /** GetCredential retrieves a credential by ID */
  async getCredential(id: string): Promise<Credential> {
    const path = `/credentials/${encodeURIComponent(id)}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as Credential;
  }

  /** CreateCredential creates a new credential */
  async createCredential(input: CredentialInput): Promise<Credential> {
    const data = await this.client.post("/credentials", input);
    return JSON.parse(data) as Credential;
  }

  /** UpdateCredential updates an existing credential */
  async updateCredential(id: string, input: Partial<CredentialInput>): Promise<Credential> {
    const path = `/credentials/${encodeURIComponent(id)}`;
    const data = await this.client.patch(path, input);
    return JSON.parse(data) as Credential;
  }

  /** DeleteCredential deletes a credential by ID */
  async deleteCredential(id: string): Promise<void> {
    const path = `/credentials/${encodeURIComponent(id)}`;
    await this.client.delete(path);
  }

  /** GetCredentialSchema retrieves the schema for a credential type */
  async getCredentialSchema(typeName: string): Promise<CredentialSchema> {
    const path = `/credentials/schema/${encodeURIComponent(typeName)}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as CredentialSchema;
  }

  /** TransferCredential transfers a credential to a different project */
  async transferCredential(id: string, input: TransferInput): Promise<void> {
    const path = `/credentials/${encodeURIComponent(id)}/transfer`;
    await this.client.put(path, input);
  }
}
