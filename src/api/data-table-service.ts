import type { Client } from "./client.ts";
import type {
  DataTable,
  DataTableFilter,
  DataTableInput,
  DataTableRow,
  DataTableUpdateInput,
  InsertRowsInput,
  ListDataTableRowsResponse,
  ListDataTablesResponse,
  UpdateRowsInput,
  UpsertRowInput,
} from "./types.ts";

/** ListDataTablesOptions represents options for listing data tables */
export interface ListDataTablesOptions {
  limit?: number;
  cursor?: string;
  filter?: string;
  sortBy?: string;
}

/** ListDataTableRowsOptions represents options for listing data table rows */
export interface ListDataTableRowsOptions {
  limit?: number;
  cursor?: string;
  filter?: string;
  sortBy?: string;
  search?: string;
}

/** DeleteRowsOptions represents options for deleting rows */
export interface DeleteRowsOptions {
  returnData?: boolean;
  dryRun?: boolean;
}

/** DataTableService handles data table API operations */
export class DataTableService {
  constructor(private readonly client: Client) {}

  /** listDataTables lists data tables with optional pagination and filtering */
  async listDataTables(opts?: ListDataTablesOptions): Promise<ListDataTablesResponse> {
    const params = new URLSearchParams();

    if (opts) {
      if (opts.limit && opts.limit > 0) {
        params.set("limit", String(opts.limit));
      }
      if (opts.cursor) {
        params.set("cursor", opts.cursor);
      }
      if (opts.filter) {
        params.set("filter", opts.filter);
      }
      if (opts.sortBy) {
        params.set("sortBy", opts.sortBy);
      }
    }

    const query = params.toString();
    const path = query ? `/data-tables?${query}` : "/data-tables";

    const data = await this.client.get(path);
    return JSON.parse(data) as ListDataTablesResponse;
  }

  /** listAllDataTables lists all data tables with automatic pagination */
  async listAllDataTables(): Promise<DataTable[]> {
    const all: DataTable[] = [];
    const opts: ListDataTablesOptions = { limit: 250 };

    for (;;) {
      const resp = await this.listDataTables(opts);
      all.push(...resp.data);

      if (!resp.nextCursor) {
        break;
      }
      opts.cursor = resp.nextCursor;
    }

    return all;
  }

  /** getDataTable retrieves a data table by ID */
  async getDataTable(id: string): Promise<DataTable> {
    const path = `/data-tables/${encodeURIComponent(id)}`;
    const data = await this.client.get(path);
    return JSON.parse(data) as DataTable;
  }

  /** createDataTable creates a new data table */
  async createDataTable(input: DataTableInput): Promise<DataTable> {
    const data = await this.client.post("/data-tables", input);
    return JSON.parse(data) as DataTable;
  }

  /** updateDataTable updates an existing data table */
  async updateDataTable(id: string, input: DataTableUpdateInput): Promise<DataTable> {
    const path = `/data-tables/${encodeURIComponent(id)}`;
    const data = await this.client.patch(path, input);
    return JSON.parse(data) as DataTable;
  }

  /** deleteDataTable deletes a data table by ID */
  async deleteDataTable(id: string): Promise<void> {
    const path = `/data-tables/${encodeURIComponent(id)}`;
    await this.client.delete(path);
  }

  /** listRows lists rows in a data table with optional pagination */
  async listRows(
    tableId: string,
    opts?: ListDataTableRowsOptions,
  ): Promise<ListDataTableRowsResponse> {
    const params = new URLSearchParams();

    if (opts) {
      if (opts.limit && opts.limit > 0) {
        params.set("limit", String(opts.limit));
      }
      if (opts.cursor) {
        params.set("cursor", opts.cursor);
      }
      if (opts.filter) {
        params.set("filter", opts.filter);
      }
      if (opts.sortBy) {
        params.set("sortBy", opts.sortBy);
      }
      if (opts.search) {
        params.set("search", opts.search);
      }
    }

    const query = params.toString();
    const basePath = `/data-tables/${encodeURIComponent(tableId)}/rows`;
    const path = query ? `${basePath}?${query}` : basePath;

    const data = await this.client.get(path);
    return JSON.parse(data) as ListDataTableRowsResponse;
  }

  /** listAllRows lists all rows in a data table with automatic pagination */
  async listAllRows(tableId: string): Promise<DataTableRow[]> {
    const all: DataTableRow[] = [];
    const opts: ListDataTableRowsOptions = { limit: 250 };

    for (;;) {
      const resp = await this.listRows(tableId, opts);
      all.push(...resp.data);

      if (!resp.nextCursor) {
        break;
      }
      opts.cursor = resp.nextCursor;
    }

    return all;
  }

  /** insertRows inserts rows into a data table */
  async insertRows(tableId: string, input: InsertRowsInput): Promise<unknown> {
    const path = `/data-tables/${encodeURIComponent(tableId)}/rows`;
    const data = await this.client.post(path, input);
    return JSON.parse(data);
  }

  /** updateRows updates rows in a data table */
  async updateRows(tableId: string, input: UpdateRowsInput): Promise<unknown> {
    const path = `/data-tables/${encodeURIComponent(tableId)}/rows/update`;
    const data = await this.client.patch(path, input);
    return JSON.parse(data);
  }

  /** upsertRow upserts rows in a data table */
  async upsertRow(tableId: string, input: UpsertRowInput): Promise<unknown> {
    const path = `/data-tables/${encodeURIComponent(tableId)}/rows/upsert`;
    const data = await this.client.post(path, input);
    return JSON.parse(data);
  }

  /** deleteRows deletes rows from a data table */
  async deleteRows(
    tableId: string,
    filter: DataTableFilter,
    opts?: DeleteRowsOptions,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.set("filter", JSON.stringify(filter));

    if (opts?.returnData) {
      params.set("returnData", "true");
    }
    if (opts?.dryRun) {
      params.set("dryRun", "true");
    }

    const path = `/data-tables/${encodeURIComponent(tableId)}/rows/delete?${params.toString()}`;
    const data = await this.client.delete(path);
    return JSON.parse(data);
  }
}
