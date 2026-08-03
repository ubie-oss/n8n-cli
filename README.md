# n8n-cli

A command-line interface for managing [n8n](https://n8n.io/) workflows as code. Import, export, lint, format, test, and deploy workflow definitions from your terminal.

## Features

- **Apply** - Deploy local workflow definitions (JSON/YAML) to an n8n server with dry-run support and conflict detection
- **Convert** - Convert workflow files between JSON and YAML formats locally
- **Import** - Pull workflows from an n8n server to local files, with optional YAML conversion and code externalization
- **Lint** - Validate workflow definitions against configurable rules
- **Proxy** - Transparent HTTP proxy that intercepts workflow saves to the n8n public API and runs lint server-side, blocking violations before they reach n8n
- **Format** - Auto-organize node positions for cleaner workflow layouts
- **Test** - Execute CLI tests against workflows via webhook endpoints
- **Webhook** - List and call a workflow's webhook nodes through the authenticated egress path
- **Workflow management** - List, get, create, update, delete, activate, and deactivate workflows via the n8n API
- **Execution management** - List executions, get execution details, delete, retry, and stop executions
- **Tag management** - List, get, create, update, and delete tags
- **Credential management** - List, get, create, update, delete credentials, get schema, and transfer between projects
- **Data table management** - List, get, create, update, delete data tables and manage rows (insert, update, upsert, delete)
- **Node schema** - Inspect built-in node type schemas (list and dump)
- **Trace** - Analyze data flow and item cardinality through workflow nodes
- **Git integration** - Apply only workflows changed in a Git diff
- **YAML support** - Work with YAML workflow definitions and external code/SQL files
- **CLAUDE.md integration** - Read project settings (default project ID, auto tags, YAML mode) from CLAUDE.md

## Installation

### Prerequisites

- [Bun](https://bun.sh/) v1.0 or later

### Build from source

```bash
git clone https://github.com/ubie-oss/n8n-cli.git
cd n8n-cli
bun install
make build
```

This produces a standalone `n8n-cli` binary in the project root.

### Cross-compile

Build binaries for multiple platforms:

```bash
make cross-compile
```

Outputs are placed in `dist/`:
- `n8n-cli-darwin-arm64` (macOS Apple Silicon)
- `n8n-cli-darwin-x64` (macOS Intel)
- `n8n-cli-linux-x64` (Linux x64)
- `n8n-cli-windows-x64` (Windows x64)

## Quick Start

1. Set environment variables for your n8n instance:

```bash
export N8N_API_URL="https://your-n8n-instance.example.com"
export N8N_API_KEY="your-api-key"
```

2. List workflows:

```bash
./n8n-cli workflow list
```

3. Import a workflow to a local file:

```bash
./n8n-cli import --ids=<workflow-id> --yaml -d ./definitions
```

4. Edit the local file and apply changes:

```bash
./n8n-cli apply --ids=<workflow-id> --dry-run -d ./definitions
./n8n-cli apply --ids=<workflow-id> -d ./definitions
```

## Commands

### `apply`

Deploy local workflow definitions to the n8n server.

```bash
n8n-cli apply [options]
```

| Option | Description |
|--------|-------------|
| `-d, --dir <path>` | Path to definitions directory (default: `./definitions`) |
| `-p, --project <id>` | Target project ID for workflow transfer |
| `--ids <ids>` | Comma-separated workflow IDs to process |
| `--from-git-changes <spec>` | Apply only files changed in Git diff (e.g., `origin/main..HEAD`) |
| `--dry-run` | Preview changes without applying |
| `--force` | Override conflict detection and duplicate warnings |
| `--no-auto-tag` | Disable automatic tagging |
| `--yaml` / `--no-yaml` | Enable/disable YAML file processing |
| `--allow-duplicates` | Skip the upstream duplicate-name check (the check is on by default; use `--force` to push through warnings instead of disabling the check) |
| `--no-lint` | Skip the pre-write lint check (the check is on by default; an error-level violation marks the workflow as failed and prevents the API call. `--force` does NOT bypass lint failures — they represent policy, not merge conflicts) |
| `--lint-config <path>` | Path to `.n8nlintrc.json` used by the pre-write lint check (auto-discovered if omitted) |
| `--lint-disable-rule <rules>` | Comma-separated rule names to disable during the pre-write lint check |

#### Exit Codes

| Code | Description |
|------|-------------|
| `0` | Success |
| `1` | Error detected |
| `2` | Conflict detected (dry-run) or warning detected (non-force mode) |

### `convert`

Convert workflow files between formats (JSON ↔ YAML). This is a local-only operation that does not require an n8n server connection.

```bash
n8n-cli convert [options] [files...]
```

| Option | Description |
|--------|-------------|
| `--format <format>` | Target format: `json`, `yaml` (required) |
| `-d, --directory <dir>` | Directory to scan for workflow files |
| `--ids <ids>` | Comma-separated workflow IDs to convert |
| `--tags <tags>` | Filter by tags (comma-separated, AND condition) |
| `-t, --threshold <n>` | Minimum lines for code externalization (JSON→YAML) |
| `--dry-run` | Preview conversions without writing files |
| `--keep` | Keep original files after conversion |

**Examples:**

```bash
# Convert all JSON workflows in a directory to YAML
n8n-cli convert -d ./definitions --format yaml

# Convert specific workflows by ID
n8n-cli convert -d ./definitions --format json --ids wf-100,wf-200

# Preview conversions without making changes
n8n-cli convert -d ./definitions --format yaml --dry-run

# Convert but keep the original files
n8n-cli convert -d ./definitions --format yaml --keep

# Convert a specific file
n8n-cli convert --format yaml workflow__wf-100.json
```

**Behavior:**

- **JSON → YAML**: Generates YAML with code externalization (`_subfiles/`) and `description.md`
- **YAML → JSON**: Resolves `!include` directives (inlines external files) and removes `_subfiles/` directories
- Files already in the target format are skipped
- Original files are removed after conversion unless `--keep` is specified

### `import`

Import workflows from n8n to local files.

```bash
n8n-cli import [options]
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview changes without writing files |
| `-d, --dir <directory>` | Target directory for workflow files (default: `./definitions`) |
| `--ids <ids>` | Comma-separated workflow IDs to import (empty = all) |
| `--include-archived` | Include archived workflows |
| `--yaml` / `--no-yaml` | Output as YAML format with external files / Force JSON |
| `-t, --threshold <n>` | Minimum lines for code externalization |
| `--cleanup-orphans` | Delete local files without matching remote workflow |
| `--cleanup-subfiles` | Delete orphan external files |
| `--tags <tags>` | Filter by tags (comma-separated, AND condition) |

### `lint`

Lint workflow definition files.

```bash
n8n-cli lint [options]
```

| Option | Description |
|--------|-------------|
| `-d, --dir <directory>` | Directory to scan for workflow files |
| `-f, --file <files...>` | Specific files to lint |
| `-c, --config <path>` | Path to `.n8nlintrc.json` config file |
| `--disable-rule <rules...>` | Disable specific rules |
| `--list-rules` | List all available rules and exit |
| `-o, --output <format>` | Output format: `text`, `json` (default: `text`) |
| `--tags <tags>` | Filter by tags (comma-separated, AND condition) |

#### Lint Configuration (`.n8nlintrc.json`)

Create a `.n8nlintrc.json` file to configure lint rules. Each rule can be set to:

- `"error"` / `"warning"` — enable with the specified severity
- `"off"` or `false` — disable the rule
- `["error", { ...options }]` — enable with severity and rule-specific options

```json
{
  "rules": {
    "orphaned-node": "warning",
    "node-params": "error",
    "webhook-id-required": "off"
  }
}
```

#### Lint Rules with Options

##### `banned-node`

Detects usage of banned node types. Requires the array config format to specify which nodes are banned.

| Option | Type | Description |
|--------|------|-------------|
| `nodes` | `Array<{ type: string; reason?: string }>` | List of banned node types |

- `type` — the `node.type` identifier (e.g., `n8n-nodes-base.executeCommand`)
- `reason` — optional; included in the violation message when provided

```json
{
  "rules": {
    "banned-node": ["error", {
      "nodes": [
        { "type": "n8n-nodes-base.executeCommand", "reason": "Security risk: arbitrary command execution" },
        { "type": "n8n-nodes-base.code", "reason": "Use HTTP Request node instead" },
        { "type": "n8n-nodes-base.ssh" }
      ]
    }]
  }
}
```

##### `no-plaintext-secrets`

Detects plaintext secrets (API keys, tokens, passwords) embedded in node parameters. Enabled by default with severity `error`. Detection is best-effort and layered:

1. **Schema-declared password fields** — parameters that n8n itself masks as passwords (`typeOptions.password` in node schemas, e.g. `crypto.secret`, `jwt.token`, `*.password`) containing literal values
2. **Sensitive name heuristics** — keys like `Authorization`, `X-API-Key`, `api_key`, `token`, `secret`, `password`, `cookie` in HTTP Request / GraphQL header collections, query parameter collections, Set node assignments, embedded JSON strings (`jsonHeaders`, `jsonBody`, ...), URL query strings (`?api_key=...`), and URL userinfo (`https://user:password@host`)
3. **Known token formats** — string values anywhere (including Code node source and sticky notes) matching well-known secret formats: AWS access keys, GitHub/GitLab/Slack/npm tokens, OpenAI/Anthropic/Google/Stripe/SendGrid/Twilio API keys, JWTs, private key blocks, and `password: "..."`-style assignments

Values written as n8n expressions (e.g. `=Bearer {{ $env.API_TOKEN }}`) are considered safe, and secret values are redacted in lint messages.

| Option | Type | Description |
|--------|------|-------------|
| `additionalNames` | `string[]` | Extra key names to treat as sensitive |
| `additionalPatterns` | `string[]` | Extra value regexes to treat as secrets |
| `allowValues` | `string[]` | Regexes; matching values are never flagged (e.g. test fixtures) |
| `minSecretLength` | `number` | Minimum literal length for name-based checks (default: `8`) |

```json
{
  "rules": {
    "no-plaintext-secrets": ["error", {
      "additionalNames": ["signingSeed"],
      "additionalPatterns": ["ACME-INTERNAL-[0-9]{10}"],
      "allowValues": ["^test-fixture-"],
      "minSecretLength": 8
    }]
  }
}
```

##### `schedule-trigger-frequency`

Validates that Schedule Trigger nodes don't fire more frequently than a configured minimum interval.

| Option | Type | Description |
|--------|------|-------------|
| `minInterval` | `"minutes"` \| `"hourly"` \| `"daily"` \| `"weekly"` \| `"monthly"` | Minimum allowed trigger interval (default: `"hourly"`) |

```json
{
  "rules": {
    "schedule-trigger-frequency": ["warning", { "minInterval": "daily" }]
  }
}
```

#### Other Lint Rules

##### `filter-operator-valid`

Validates that If / Filter node conditions (typeVersion >= 2) use valid operator operations. For example, it flags `isNotEmpty` and suggests `notEmpty` instead. Invalid operations silently evaluate to `false` at runtime, making bugs hard to detect.

Targets: `n8n-nodes-base.if`, `n8n-nodes-base.filter`

Enabled by default with severity `error`.

```json
{
  "rules": {
    "filter-operator-valid": "error"
  }
}
```

### `fmt`

Format workflow files by reorganizing node positions.

```bash
n8n-cli fmt [options] [files...]
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Show changes without saving |
| `-d, --directory <dir>` | Directory to scan for workflow files |
| `--tags <tags>` | Filter by tags (comma-separated, AND condition) |

### `test`

Run CLI test against a workflow via its test webhook.

```bash
n8n-cli test <workflow-id> [options]
```

| Option | Description |
|--------|-------------|
| `-d, --data <json>` | JSON data to send to the webhook |
| `--timeout <ms>` | HTTP request timeout in milliseconds (default: 30000) |
| `--wait-execution` | Wait for execution to complete and show results |
| `--execution-timeout <ms>` | Max time to wait for execution (default: 300000) |
| `--activate` | Automatically activate the workflow if inactive |
| `--dry-run` | Show webhook URL without executing |
| `--show-inputs` | Display workflow input parameters without executing |

### `webhook`

Call a workflow's webhook through the CLI's authenticated egress path.

```bash
n8n-cli webhook list <workflow-id>
n8n-cli webhook call <workflow-id> --node "<node name>" [options]
```

**Why this exists, given `curl`.** When n8n sits behind a gateway that
authenticates callers per request, the credentials are minted by the
[egress middleware chain](#talking-to-an-authenticating-gateway) inside this
process. Every other command already goes through it; webhook URLs sit outside
`/api/v1` and had no way in. Reproducing that outside the CLI means
reimplementing token minting, impersonation and caching — so the transport is
the one part that belongs here.

`webhook call` options:

| Option | Description |
|--------|-------------|
| `-n, --node <name>` | **Required.** Exact name of the webhook node to call |
| `-d, --data <json>` | JSON body to send |
| `--timeout <ms>` | HTTP request timeout in milliseconds (default: 30000) |
| `--dry-run` | Print the resolved URL without calling it |
| `--allow-inactive` | Call even when the workflow is inactive |

**`--node` is required on purpose.** The command never searches, guesses, or
falls back to "the only webhook in the workflow". Every webhook in an n8n
instance is a live entry point and some are wired to inbound events from other
systems; a caller that has to name the node cannot fire one it did not mean to.
Use `webhook list` to see what a workflow exposes.

**No policy beyond that.** This command takes no position on which webhooks are
safe to call, what they should be named, or whether they ought to return data.
Those are deployment policy: they differ per organization, and a naming
convention compiled into a released binary is a convention nobody can change.
If you are building "let an agent run a workflow on request", put the rules —
which nodes qualify, whether the response may carry data, who may ask — in the
layer that owns them, and hand this command a node name.

Set `N8N_WEBHOOK_TOKEN` when the node uses n8n's header auth; it is sent as
`x-n8n-webhook-token` (override the header with `N8N_WEBHOOK_TOKEN_HEADER`).
That authenticates the request to n8n itself, separately from the gateway
credentials the egress middlewares attach.

Compared with [`test`](#test): `test` targets `[CLI Test]` webhooks by
convention, waits for the execution and reports its status — a development
affordance. `webhook` addresses any webhook by name and just performs the call.

### `workflow`

Manage n8n workflows.

```bash
n8n-cli workflow <subcommand>
```

#### `workflow list`

List all workflows.

| Option | Description |
|--------|-------------|
| `--active` | List only active workflows |
| `--inactive` | List only inactive workflows |
| `--tags <tags>` | Filter by tags (comma-separated) |
| `--limit <n>` | Maximum number of workflows to return (0 = all, default: `0`) |

#### `workflow get <id>`

Get a workflow by ID.

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Output file path (writes JSON to file) |

#### `workflow create`

Create a new workflow. The pre-write lint check runs by default — any error-level violation blocks the API call.

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Path to workflow JSON file, use `-` for stdin (required) |
| `--no-lint` | Skip the pre-write lint check (on by default) |
| `--lint-config <path>` | Path to `.n8nlintrc.json` for the pre-write lint check |
| `--lint-disable-rule <rules>` | Comma-separated rule names to disable during the pre-write lint check |

#### `workflow update [id]`

Update an existing workflow. The ID argument is optional if the JSON file contains an `id` field. The pre-write lint check runs by default — any error-level violation blocks the API call.

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Path to workflow JSON file, use `-` for stdin (required) |
| `--force` | Force update even if remote has been modified |
| `--no-lint` | Skip the pre-write lint check (on by default) |
| `--lint-config <path>` | Path to `.n8nlintrc.json` for the pre-write lint check |
| `--lint-disable-rule <rules>` | Comma-separated rule names to disable during the pre-write lint check |

#### `workflow delete <ids...>`

Delete one or more workflows.

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt |

#### `workflow activate <id>`

Activate a workflow.

#### `workflow deactivate <id>`

Deactivate a workflow.

### `execution`

Manage n8n workflow executions.

```bash
n8n-cli execution <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List workflow executions |
| `get <id>` | Get execution details by ID |
| `delete <id>` | Delete an execution by ID |
| `retry <id>` | Retry a failed execution |
| `stop <id>` | Stop a running execution |

#### `execution list`

```bash
n8n-cli execution list [options]
```

| Option | Description |
|--------|-------------|
| `-w, --workflow <id>` | Filter by workflow ID |
| `-s, --status <status>` | Filter by status (`success`, `error`, `running`, `waiting`) |
| `-l, --limit <n>` | Maximum number of executions to return (default: 20) |

#### `execution get`

```bash
n8n-cli execution get <id> [options]
```

| Option | Description |
|--------|-------------|
| `--show-data` | Include node execution summary in output |

**Output includes:**
- Execution ID, workflow ID, status, mode
- Start and stop timestamps
- Error details (node, message, description) if the execution failed
- Node execution summary (with `--show-data`)

#### `execution delete`

Delete an execution by ID.

```bash
n8n-cli execution delete <id>
```

#### `execution retry`

Retry a failed execution.

```bash
n8n-cli execution retry <id>
```

#### `execution stop`

Stop a running execution.

```bash
n8n-cli execution stop <id>
```

### `tag`

Manage n8n tags.

```bash
n8n-cli tag <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all tags |
| `get <id>` | Get a tag by ID |
| `create <name>` | Create a new tag |
| `update <id>` | Update an existing tag |
| `delete <ids...>` | Delete one or more tags |

#### `tag list`

```bash
n8n-cli tag list [options]
```

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Maximum number of tags to return |

#### `tag get`

Get a tag by ID.

```bash
n8n-cli tag get <id>
```

#### `tag create`

Create a new tag.

```bash
n8n-cli tag create <name>
```

#### `tag update`

Update an existing tag.

```bash
n8n-cli tag update <id> [options]
```

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | New tag name (required) |

#### `tag delete`

Delete one or more tags.

```bash
n8n-cli tag delete <ids...> [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt |

### `credential`

Manage n8n credentials.

```bash
n8n-cli credential <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all credentials |
| `get <id>` | Get a credential by ID |
| `create` | Create a new credential |
| `update <id>` | Update an existing credential |
| `delete <ids...>` | Delete one or more credentials |
| `schema <typeName>` | Get the schema for a credential type |
| `transfer <id>` | Transfer a credential to a different project |

#### `credential list`

```bash
n8n-cli credential list [options]
```

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Maximum number of credentials to return |

#### `credential get`

Get a credential by ID.

```bash
n8n-cli credential get <id>
```

#### `credential create`

Create a new credential.

```bash
n8n-cli credential create [options]
```

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | Credential name (required) |
| `-t, --type <type>` | Credential type, e.g., `slackApi` (required) |
| `-d, --data <json>` | Credential data as JSON string (required) |

#### `credential update`

Update an existing credential.

```bash
n8n-cli credential update <id> [options]
```

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | New credential name |
| `-t, --type <type>` | New credential type |
| `-d, --data <json>` | New credential data as JSON string |

#### `credential delete`

Delete one or more credentials.

```bash
n8n-cli credential delete <ids...> [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt |

#### `credential schema`

Get the schema for a credential type.

```bash
n8n-cli credential schema <typeName>
```

#### `credential transfer`

Transfer a credential to a different project.

```bash
n8n-cli credential transfer <id> [options]
```

| Option | Description |
|--------|-------------|
| `-p, --project <projectId>` | Destination project ID (required) |

### `data-tables`

Manage n8n data tables and their rows.

```bash
n8n-cli data-tables <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all data tables |
| `get <id>` | Get a data table by ID |
| `create` | Create a new data table |
| `update <id>` | Update an existing data table |
| `delete <ids...>` | Delete one or more data tables |
| `rows list <dataTableId>` | List rows in a data table |
| `rows insert <dataTableId>` | Insert rows into a data table |
| `rows update <dataTableId>` | Update rows in a data table |
| `rows upsert <dataTableId>` | Upsert rows in a data table |
| `rows delete <dataTableId>` | Delete rows from a data table |

#### `data-tables list`

```bash
n8n-cli data-tables list [options]
```

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Maximum number of data tables to return |
| `--filter <json>` | Filter as JSON string |
| `--sort-by <field:dir>` | Sort by field and direction (e.g., `name:asc`) |

#### `data-tables get`

Get a data table by ID, including column definitions.

```bash
n8n-cli data-tables get <id>
```

#### `data-tables create`

Create a new data table with column definitions.

```bash
n8n-cli data-tables create [options]
```

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | Data table name (required) |
| `-c, --columns <json>` | Columns as JSON array (required), e.g., `'[{"name":"col1","type":"string"}]'` |

Supported column types: `string`, `number`, `boolean`, `date`, `json`.

#### `data-tables update`

Update an existing data table (name only).

```bash
n8n-cli data-tables update <id> [options]
```

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | New data table name (required) |

#### `data-tables delete`

Delete one or more data tables.

```bash
n8n-cli data-tables delete <ids...> [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompt |

#### `data-tables rows list`

List rows in a data table.

```bash
n8n-cli data-tables rows list <dataTableId> [options]
```

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Maximum number of rows to return |
| `--filter <json>` | Filter as JSON string |
| `--sort-by <field:dir>` | Sort by field and direction |
| `--search <text>` | Search text |

#### `data-tables rows insert`

Insert rows into a data table.

```bash
n8n-cli data-tables rows insert <dataTableId> [options]
```

| Option | Description |
|--------|-------------|
| `-d, --data <json>` | Row data as JSON array (required), e.g., `'[{"col1":"value"}]'` |
| `--return-type <type>` | Return type: `count`, `id`, or `all` (default: `count`) |

#### `data-tables rows update`

Update rows matching a filter.

```bash
n8n-cli data-tables rows update <dataTableId> [options]
```

| Option | Description |
|--------|-------------|
| `--filter <json>` | Filter as JSON string (required) |
| `-d, --data <json>` | Update data as JSON object (required) |
| `--return-data` | Return updated data |
| `--dry-run` | Dry run without making changes |

#### `data-tables rows upsert`

Upsert rows matching a filter.

```bash
n8n-cli data-tables rows upsert <dataTableId> [options]
```

| Option | Description |
|--------|-------------|
| `--filter <json>` | Filter as JSON string (required) |
| `-d, --data <json>` | Upsert data as JSON object (required) |
| `--return-data` | Return upserted data |
| `--dry-run` | Dry run without making changes |

#### `data-tables rows delete`

Delete rows matching a filter.

```bash
n8n-cli data-tables rows delete <dataTableId> [options]
```

| Option | Description |
|--------|-------------|
| `--filter <json>` | Filter as JSON string (required) |
| `--return-data` | Return deleted data |
| `--dry-run` | Dry run without making changes |
| `--force` | Skip confirmation prompt |

### `node-schema`

Inspect built-in node type schemas.

```bash
n8n-cli node-schema <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all built-in node types |
| `dump` | Dump full node schema definitions |

#### `node-schema list`

```bash
n8n-cli node-schema list [options]
```

| Option | Description |
|--------|-------------|
| `--output <format>` | Output format: `table`, `json` (default: `table`) |
| `--group <name>` | Filter by group name (e.g., `trigger`, `transform`) |

#### `node-schema dump`

```bash
n8n-cli node-schema dump [options]
```

| Option | Description |
|--------|-------------|
| `--type <nodeType>` | Dump a specific node type (e.g., `n8n-nodes-base.slack`) |
| `-o, --output-dir <dir>` | Dump all nodes as individual JSON files to a directory |

**Prerequisites:** Requires `n8n-nodes-base` and `@n8n/n8n-nodes-langchain` in `node_modules`.

### `trace`

Analyze data flow and item cardinality through workflow nodes.

```bash
n8n-cli trace [options]
```

| Option | Description |
|--------|-------------|
| `-d, --dir <directory>` | Directory to scan for workflow files |
| `-f, --file <files...>` | Specific files to trace |
| `--json` | Output in JSON format |
| `--tags <tags>` | Filter by tags (comma-separated, AND condition) |

**Output columns:**

| Column | Description |
|--------|-------------|
| Node | Node name |
| Type | n8n node type |
| Cardinality | Output cardinality: `1:1`, `1:N`, `N:1`, `pass-through`, `variable`, `unknown` |
| Items | Estimated output item count |
| Inputs | Upstream nodes |
| Outputs | Downstream nodes |

### `proxy`

Run a transparent HTTP proxy in front of an n8n server that intercepts workflow saves on the public REST API and runs the linter server-side. Workflows that violate `error`-severity rules are rejected with HTTP 422 before they reach n8n.

This solves a common problem: when humans or AI agents push workflows directly to the n8n API (bypassing client-side lint), poor quality definitions silently end up in production. The proxy makes lint enforcement structural rather than convention-based.

```bash
n8n-cli proxy [options]
```

| Option | Description |
|--------|-------------|
| `--listen <addr>` | Address to bind, e.g. `:8080` or `127.0.0.1:8080` (default: `:8080`) |
| `--upstream <url>` | Upstream n8n base URL (env: `N8N_API_URL`) |
| `-c, --lint-config <path>` | Path to `.n8nlintrc.json` (auto-discovered if omitted) |
| `--enforce <level>` | `off`, `warn`, or `error` (default: `error`) |
| `--disable-rule <rules...>` | Disable specific rules (can be repeated) |
| `--log-format <fmt>` | Log format: `text` or `json` (default: `text`) |
| `--allow-duplicates` | Skip the upstream duplicate-name check (the check is on by default) |
| `--duplicate-ttl <ms>` | TTL for the cached upstream workflow-name index (default: 60000) |
| `--upstream-timeout <ms>` | Per-request upstream timeout in milliseconds (default: 30000, 0 disables) |
| `--middleware <list>` | Comma-separated middleware chain (default: `lint`; env: `N8N_MIDDLEWARES`). Example: `lint,authz` |
| `--tags <tags>` | Only run middleware against workflow saves whose tags contain ALL of the listed names (AND condition; env: `PROXY_FILTER_BY_TAGS`). Non-matching saves are forwarded transparently |

**Enforcement levels:**

| Level | Behavior |
|-------|----------|
| `off` | Forwards every request; lint runs only for audit logging |
| `warn` | Forwards every request; attaches `X-N8n-Lint-Violations` and `X-N8n-Lint-Errors` headers to the response |
| `error` | Blocks requests with any error-level violation; returns HTTP 422 with a violations JSON body. Warnings still pass through |

**Intercepted endpoints (n8n public API only):**

- `POST /api/v1/workflows` (create)
- `PUT /api/v1/workflows/:id` (update)

All other paths (including the n8n editor's internal `/rest/*` routes) are forwarded transparently. The `X-N8N-API-KEY` header is passed through as-is.

**Example: run the proxy in front of a production n8n**

```bash
n8n-cli proxy \
  --listen :8080 \
  --upstream https://n8n.example.com \
  --enforce error \
  --log-format json
```

Clients then point at `http://proxy-host:8080` instead of n8n directly. From the client's perspective the API is identical, except that lint-violating saves now return:

```json
{
  "error": "workflow_lint_failed",
  "message": "Workflow violates 2 linter rules and was not forwarded to n8n",
  "violations": [
    { "rule": "required-fields", "severity": "error", "message": "Missing required field: \"name\"" }
  ],
  "docs": "https://github.com/ubie-oss/n8n-cli#lint"
}
```

**Apply-style safety checks:** beyond lint, the proxy mirrors the same default-on duplicate-name safety that `apply` enforces. On every `POST /api/v1/workflows` the proxy fetches the upstream workflow list (cached for `--duplicate-ttl` milliseconds) and rejects creates that collide with an existing remote name. Under `--enforce error` this returns 409; under `--enforce warn` an `X-N8n-Duplicate-Warning` header is attached to the forwarded response. Pass `--allow-duplicates` to disable the check entirely (e.g. during a one-off bulk import). Lookups run under the caller's own `X-N8N-API-KEY` so duplicate detection never escalates privileges.

**Rollout tip:** start with `--enforce warn` to audit the violation distribution in production logs, then flip to `--enforce error` once the team has cleaned up existing violations.

**Scoping by tags:** pass `--tags managed,prod` (or set `PROXY_FILTER_BY_TAGS`) to constrain middleware enforcement to workflow saves whose `tags` contain every listed name. Saves outside that scope are forwarded transparently — no lint, no duplicate-name check, no authz. Useful when only a subset of workflows on the upstream is under policy. Filtering is AND across the listed names.

> **Scope is advisory, not an enforcement boundary.** The filter reads tags from the request body the client sent, not from the existing upstream workflow, so a caller can bypass middleware by stripping the tag from the JSON they submit. Use it to opt subsets of workflows into policy (organizational scoping), not to defend against a hostile client; for hard enforcement keep the filter empty so every save is checked, or pair the filter with API-key / network-level access controls.

**Health probes:**

| Path | Method | Behavior |
|------|--------|----------|
| `GET`/`HEAD /livez` | Liveness | Always `200 ok` once the server is accepting connections. Use for Kubernetes `livenessProbe`. |
| `GET`/`HEAD /readyz` | Readiness | `200 ready` once every middleware's `prepare()` resolves; `503 preparing` (or `503 not ready` with details) while resolvers are still warming up or have failed. Use for Kubernetes `readinessProbe` so traffic is held back until authz groups, lint config, etc. are usable. |
| `GET`/`HEAD /healthz` | Generic | Always `200 ok`. Kept for backward compatibility with existing probes; new deployments should prefer `/livez` + `/readyz`. |

### `version`

Show version information including version, git commit, build date, runtime (Bun version), and OS/Arch.

```bash
n8n-cli version
# n8n-cli version 1.0.0
#   Git commit: abc1234
#   Built:      2025-01-01T00:00:00Z
#   Runtime:    Bun 1.x.x
#   OS/Arch:    darwin/arm64
```

### Global Options

| Option | Description |
|--------|-------------|
| `--api-url <url>` | n8n API URL (env: `N8N_API_URL`) |
| `--api-key <key>` | n8n API key (env: `N8N_API_KEY`) |
| `--timeout <duration>` | Request timeout, e.g. `30s`, `5m` (env: `N8N_API_TIMEOUT`) |
| `-o, --output <format>` | Output format: `json`, `table` (default: `json`) |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `N8N_API_URL` | n8n instance API URL (required) |
| `N8N_API_KEY` | n8n API key (required, unless an egress chain supplies credentials — see below) |
| `N8N_API_TIMEOUT` | Request timeout in milliseconds |
| `N8N_DEFAULT_PROJECT` | Default project ID for apply |
| `N8N_CLIENT_MIDDLEWARES` | Comma-separated egress middlewares applied to every request (see below) |
| `N8N_CLI_TEST_TOKEN` | Shared secret sent as `x-n8n-cli-test-token` by [`test`](#test) |
| `N8N_WEBHOOK_TOKEN` | Shared secret sent by [`webhook call`](#webhook) for n8n's header auth |
| `N8N_WEBHOOK_TOKEN_HEADER` | Header name for the above (default: `x-n8n-webhook-token`) |
| `APPLY_FILTER_BY_TAGS` | Comma-separated tags to filter apply targets |
| `CHECKS_FILTER_BY_TAGS` | Comma-separated tags to filter lint/fmt targets (AND condition) |
| `PROXY_FILTER_BY_TAGS` | Comma-separated tags to scope proxy middleware enforcement (AND condition) |

### Talking to an authenticating gateway

When n8n sits behind a gateway that authenticates callers per request — for example
the [`proxy`](#proxy) subcommand deployed in front of it, or an identity-aware proxy —
point `N8N_API_URL` at the gateway and enable the egress middlewares it expects.
They run on every request the CLI makes — API calls and the webhook calls behind
`test` / `webhook call` alike — so ordinary commands (`apply`, `import`,
`workflow ...`) work unchanged:

```bash
export N8N_API_URL="https://gateway.example.com"
export N8N_CLIENT_MIDDLEWARES="iap-auth,impersonator-token"

# Gate credential: mint an id_token as a service account, using local ADC as the
# caller. `aud` defaults to N8N_API_URL, which is what a Cloud Run gateway expects.
export N8N_IAP_AUTH_TOKEN_SOURCE="adc-impersonate"
export N8N_IAP_AUTH_IMPERSONATE_SERVICE_ACCOUNT="gate-caller@example.iam.gserviceaccount.com"

# Human identity side-header, so the gateway can attribute the call to a person.
# `aud` defaults to the OAuth client that issued the ADC credentials.
export N8N_IMPERSONATOR_TOKEN_SOURCE="adc"
```

`N8N_API_KEY` is not required in this setup: a gateway that terminates
authentication holds the n8n key and injects it upstream (`api-key-inject`), so
the caller never needs one. Tokens are minted on demand and cached in-process, so
no external refresh step is involved.

Available egress middlewares: `iap-auth` (Bearer id_token; sources `metadata`,
`adc-impersonate`, `env`, `static`), `impersonator-token`
(`X-Impersonator-Id-Token`; sources `adc`, `env`, `static`), `api-key-inject`.

### CLAUDE.md Integration

n8n-cli can read project settings from a `CLAUDE.md` file in your repository:

- **Default project ID** - Automatically set the target project for apply
- **Auto tags** - Tags to automatically add to deployed workflows
- **YAML mode** - Enable/disable YAML processing by default
- **Externalize threshold** - Minimum lines for code externalization during import

## Documentation

See the `docs/` directory for additional documentation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build instructions, and contribution guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
