# n8n-cli

A command-line interface for managing [n8n](https://n8n.io/) workflows as code. Import, export, lint, format, test, and deploy workflow definitions from your terminal.

## Features

- **Apply** - Deploy local workflow definitions (JSON/YAML/TypeScript) to an n8n server with dry-run support and conflict detection
- **Convert** - Convert workflow files between JSON, YAML and TypeScript formats locally
- **Import** - Pull workflows from an n8n server to local files, with optional YAML/TypeScript conversion and code externalization
- **Lint** - Validate workflow definitions against configurable rules
- **Proxy** - Transparent HTTP proxy that intercepts workflow saves to the n8n public API and runs lint server-side, blocking violations before they reach n8n, and refusing writes built from an out-of-date copy of a workflow
- **MCP gating** - Put your own policy in front of n8n's MCP server: expose only the tools you chose, and only against the workflows your convention says an agent may reach
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
- **TypeScript support** - Work with type-checked `.ts` workflow definitions written against [`@n8n/workflow-sdk`](https://www.npmjs.com/package/@n8n/workflow-sdk)
- **CLAUDE.md integration** - Read project settings (default project ID, auto tags, YAML mode, TypeScript mode) from CLAUDE.md

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
| `--ts` / `--no-ts` | Enable/disable `.ts` file processing (see [TypeScript workflow definitions](#typescript-workflow-definitions)) |
| `--allow-duplicates` | Skip the upstream duplicate-name check (the check is on by default; use `--force` to push through warnings instead of disabling the check) |
| `--no-lint` | Skip the pre-write lint check (the check is on by default; an error-level violation marks the workflow as failed and prevents the API call. `--force` does NOT bypass lint failures — they represent policy, not merge conflicts) |
| `--lint-config <path>` | Path to `.n8nlintrc.json` used by the pre-write lint check (auto-discovered if omitted) |
| `--lint-disable-rule <rules>` | Comma-separated rule names to disable during the pre-write lint check |

#### Conflict detection

A definition records the upstream `updatedAt` it was written from. Before updating, `apply` compares that stamp against the live workflow: when upstream is newer *and* the content differs, the operation is reported as a conflict instead of being pushed, because applying it would revert a change nobody imported. `--force` overrides it; `import` resolves it properly.

After a successful write the local file is re-stamped with the server's new timestamp, so the next edit is not mistaken for a conflict. In a CI-driven setup this happens on the runner, which means the stamp in version control stays behind until something writes it back — either commit the re-stamped files from the apply job, or run `import` on a schedule. Until it catches up, a second change to the same workflow will report a conflict that `--force` can push through.

> **Behaviour change (YAML):** YAML definitions written before this feature carry no `updatedAt`, and applies against them were unconditional. Once `import` re-writes them with a stamp, those same applies start reporting conflicts — which is the point, but it is a change in behaviour for existing repositories. JSON and `.ts` definitions already carried the stamp.
>
> A second consequence, on the machine that ran the apply: `import` skips a workflow whose local stamp is already current, so anything the server normalised during the write (defaulted parameters, ids it assigned) does not come back down until the workflow changes again upstream. YAML now matches what JSON has always done, and what `.ts` does deliberately. The skip is by timestamp, not by selection, so `--ids` does not override it — delete the local file, or restore the committed version whose stamp is older, and import again.

For enforcement that does not depend on the client (any working copy can pass `--force`, and other tools do not run this check at all), see the proxy's [stale-write guard](#stale-write-guard).

#### Exit Codes

| Code | Description |
|------|-------------|
| `0` | Success |
| `1` | Error detected |
| `2` | Conflict detected (dry-run) or warning detected (non-force mode) |

### `convert`

Convert workflow files between formats (JSON / YAML / TypeScript). This is a local-only operation that does not require an n8n server connection.

```bash
n8n-cli convert [options] [files...]
```

| Option | Description |
|--------|-------------|
| `--format <format>` | Target format: `json`, `yaml`, `ts` (required) |
| `--ts` | Include `.ts` files when scanning a directory (explicit file arguments are always honoured) |
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
- **→ TypeScript**: Emits a `.ts` file against `@n8n/workflow-sdk`. The generated file is parsed back and compared against the source before it is written; a workflow the SDK cannot represent faithfully fails with an error instead of being silently mangled
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
| `--ts` / `--no-ts` | Write new workflows as `.ts` against `@n8n/workflow-sdk` |
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
| `--project <id>` | Project ID context for local files. Remote lint detects ownership per workflow |

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

Rules under the top-level `rules` key are global. They continue to apply to
every workflow. Add a `projects` block keyed by n8n Project ID to layer stricter
or project-specific policy on top:

```json
{
  "rules": {
    "no-plaintext-secrets": "error",
    "banned-node": ["error", {
      "nodes": [{ "type": "n8n-nodes-base.executeCommand" }]
    }]
  },
  "projects": {
    "pLx9cQ2mNv7aB1dK": {
      "rules": {
        "banned-node": ["error", {
          "nodes": [{ "type": "n8n-nodes-base.code", "reason": "Use reviewed nodes only" }]
        }],
        "schedule-trigger-frequency": ["error", { "minInterval": "daily" }]
      }
    }
  }
}
```

The global and matching project layers both run. A project-level `"off"` only
disables that project-layer entry; it never weakens a global rule. If both
layers produce the same finding, the output contains one finding with the
stricter severity.

`lint --remote` reads the owner from each workflow's `shared` metadata. For
local definitions, pass `--project <id>` when that metadata is absent. `apply`
uses its existing `--project` / default-project setting.

#### Lint Rules with Options

##### `banned-node`

Detects usage of banned node types and enforces per-node parameter policies. Requires the array config format to specify options.

| Option | Type | Description |
|--------|------|-------------|
| `deny` | `Array<Matcher>` | Node types banned outright. `deny` wins over `allow` |
| `allow` | `Array<Matcher>` | When non-empty, switches the rule into **allowlist mode**: every node must match at least one entry, otherwise it is banned. Entries may still be narrowed by `params` |
| `params` | `Record<node-matcher, ParamsPolicy>` | Per-node parameter policy (see below). Keys are node type matchers merged in order of specificity (broadest first, exact last) |

A `Matcher` is `{ "type": "..." }` (exact) or `{ "pattern": "...", "match": "exact" \| "glob" \| "regex" }` (`match` defaults to `"glob"`). `deny` entries may carry a `reason`. The legacy `nodes: [{ type, reason }]` option is an alias for `deny`.

A `ParamsPolicy`:

| Option | Type | Description |
|--------|------|-------------|
| `allowParams` | `string[]` | When present, every **top-level** parameter name must match at least one pattern. Patterns match the parameter key (e.g. `additional*`), not a path into it |
| `denyParams` | `string[]` | Top-level parameter names matching any pattern are violations. To forbid a nested key, use `values` with an empty `allow` list |
| `expressions` | `"allow"` \| `"deny"` | Default policy for expression values on this node. Expression values are strings beginning with `=` or containing `{{ ... }}`. Default: `"allow"` |
| `values` | `Record<path, ValueRule>` | Value-level rules keyed by dot-path (`channelId.value`) supporting `*` globs and `/regex/`. For each field (`allow`, `pattern`, `expressions`) the most specific matching path rule that defines that field wins, so a broad rule and a narrow rule compose rather than shadow each other. Code-bearing params (`jsCode`, `inputSchema`) are exempt from expression checks |

A `ValueRule` combines three orthogonal constraints:

| Option | Type | Description |
|--------|------|-------------|
| `allow` | `string[]` | Exact values the parameter may hold. An empty array forbids the path entirely |
| `pattern` | `string` | A glob (default) or, with `match: "regex"`, a regular expression the value must match |
| `expressions` | `"allow"` \| `"deny"` | Overrides the node's `expressions` policy for just that path |

Expression values skip the literal `allow` / `pattern` checks because they are dynamic; the expressions policy decides their fate instead. Invalid matchers, regexes and option values are reported as `error`-severity config violations.

```json
{
  "rules": {
    "banned-node": ["error", {
      "deny": [
        { "type": "n8n-nodes-base.executeCommand", "reason": "Security risk: arbitrary command execution" },
        { "pattern": "n8n-nodes-base.*Command", "match": "glob" },
        { "pattern": "n8n-nodes-base\\.(code|function)", "match": "regex" }
      ],
      "allow": [
        { "type": "n8n-nodes-base.slack" },
        { "type": "n8n-nodes-base.httpRequest" }
      ],
      "params": {
        "*": { "expressions": "deny" },
        "n8n-nodes-base.slack": {
          "allowParams": ["resource", "operation", "channelId", "text", "additionalFields"],
          "denyParams": ["messageType"],
          "values": {
            "channelId.value": { "allow": ["#general", "#ops"] },
            "text": { "expressions": "allow" }
          }
        },
        "n8n-nodes-base.httpRequest": {
          "allowParams": ["url", "method"],
          "values": { "url": { "pattern": "^https://", "match": "regex" } }
        }
      }
    }]
  }
}
```

The example above bans `executeCommand`, all `*Command` glob matches and the Code/Function nodes; only Slack and HTTP Request are allowed; expressions are forbidden everywhere except `text` on Slack; Slack may only post to `#general` or `#ops`; and HTTP Request may only target `https://` URLs.

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

##### `mcp-tool-description`

Checks that a workflow reachable through n8n's instance-level MCP server carries a description worth reading. Enabled by default with severity `warning`; it does nothing to a workflow that is not MCP-exposed.

A workflow with `settings.availableInMCP` is a tool an agent can call, and the top-level `description` is what n8n hands the model — in `search_workflows` results and in `get_workflow_details` — to decide whether to call it. n8n truncates it at 255 characters from v2.27.0.

| Option | Type | Description |
|--------|------|-------------|
| `mcpTags` | `string[]` | Tag names that also mean "exposed over MCP", for repositories that mark intent with a tag |
| `minLength` | `number` | Shortest description accepted (default: `20`; `0` disables) |
| `maxLength` | `number` | Longest description accepted (default: `255`, n8n's own limit) |

```json
{
  "rules": {
    "mcp-tool-description": ["error", { "mcpTags": ["mcp"], "minLength": 40 }]
  }
}
```

##### `mcp-exposure`

Enforces your own rule about *which* workflows may be exposed over MCP. Enabled by default with severity `warning`, but every check is opt-in: with no options the rule does nothing, because there is no convention it could guess.

n8n's `Available in MCP` toggle is per-workflow and anyone with edit rights can flip it in the UI, so on its own it is not a policy — it is whatever the last person clicked. Pair it with a tag and a naming convention and it becomes one, reviewable in the diff.

| Option | Type | Description |
|--------|------|-------------|
| `requireTags` | `string[]` | Tags an MCP-exposed workflow must carry (all of them) |
| `namePattern` | `string` | Regular expression the workflow name must match |
| `mcpTags` | `string[]` | Tags that mean "meant for MCP" even when the setting is off |
| `requireSetting` | `boolean` | When true, a workflow carrying an `mcpTags` tag must also have `settings.availableInMCP` — otherwise the tag promises access n8n refuses |
| `entryPathPattern` | `string` | `*`-glob the [entry trigger's](#the-entry-trigger) path must match. Pass the same glob the proxy runs with, so CI and the gate agree. The message names the node that would actually fire, which node order otherwise hides |

```json
{
  "rules": {
    "mcp-exposure": ["error", {
      "mcpTags": ["mcp"],
      "requireTags": ["mcp"],
      "requireSetting": true,
      "entryPathPattern": "__mcp__/*"
    }]
  }
}
```

#### Other Lint Rules

##### `execute-workflow-inputs-extra` / `execute-workflow-inputs-missing`

Compare an Execute Sub-workflow node's `workflowInputs.value` keys with the input names declared by the called workflow's Execute Sub-workflow Trigger. Extra caller keys are errors; declared inputs omitted by the caller are warnings. Dynamic workflow IDs and workflows that accept all input data are skipped.

The called workflow must be part of the same lint batch. Use `--remote`, `--dir`, or pass both files to `--file` so the linter can resolve the workflow ID.

##### `node-ref-field-check`

Checks explicit references such as `$('Node').item.json.foo` against known output fields. For Set nodes configured without **Include Other Input Fields**, assignment names are treated as the complete output schema, so references to fields that the Set node drops are reported as warnings.

##### `external-node-repeated-call` / `external-node-static-repeated-call`

Detect BigQuery, HTTP Request, Notion, and Slack nodes that can receive multiple items from an upstream `1:N` node while **Execute Once** is disabled. A call that references upstream input is a warning. Repeating the same input-independent call is an error. Pass-through nodes between the `1:N` producer and external node are followed.

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
| `--server-middleware <list>` | Comma-separated server-middleware chain (default: `lint`; env: `N8N_SERVER_MIDDLEWARES`). Example: `lint,authz` |
| `--tags <tags>` | Only run middleware against workflow saves whose tags contain ALL of the listed names (AND condition; env: `PROXY_FILTER_BY_TAGS`). Non-matching saves are forwarded transparently |
| `--stale-write-enforce <level>` | Stale-write guard: `off` (default), `warn`, or `error`. Requires `stale-write` in the middleware chain |
| `--stale-write-on-missing-base <mode>` | Callers that declare no base revision: `allow` (default) or `deny` |
| `--stale-write-on-error <mode>` | When the stored workflow cannot be read: `deny` (default) or `allow` |
| `--stale-write-actions <actions>` | Route actions the guard applies to (default: `update`) |

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

When project-scoped lint rules are configured, updates are matched to the
owner Project ID read from the stored upstream workflow. Creates do not carry
ownership in n8n's public workflow payload, so n8n-cli sends
`X-N8n-Project-Id` when `apply` has a target project. The proxy consumes and
strips this control header. A create without a declared project receives only
the global rule layer.

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

#### Stale-write guard

Lint asks whether a workflow is any good. The stale-write guard asks a different question: has the author seen the state they are about to overwrite?

The failure it exists for is not a bad workflow. Someone edits a workflow in the n8n UI, nobody imports the change back into the repository, and the next `apply` from any working copy silently reverts it. That write is well-formed, authorized and in scope, so every other check waves it through.

Add `stale-write` to the server-middleware chain to turn it on:

```bash
n8n-cli proxy \
  --upstream https://n8n.example.com \
  --server-middleware lint,stale-write \
  --stale-write-enforce error
```

The client states which upstream revision its definition was based on, in an `X-N8n-Base-Updated-At` header — `n8n-cli apply` sends the `updatedAt` recorded in the local definition. The proxy reads the *stored* workflow (uncached: the whole point is that it reflects upstream right now, under the caller's own `X-N8N-API-KEY`) and compares. A mismatch in either direction is refused:

```json
{
  "error": "workflow_stale_write",
  "message": "Workflow abc123 was updated upstream at 2026-03-01T10:00:00.000Z, but this write is based on 2026-02-01T10:00:00.000Z. Applying it would revert changes the caller has never seen. Import the workflow and re-apply."
}
```

Under `--stale-write-enforce warn` the write is forwarded with an `X-N8n-Stale-Write-Warning` response header instead, which is the way to measure how often this is happening before turning enforcement on.

**Callers that declare no base** — the n8n UI itself, raw API calls, older `n8n-cli` versions, and any definition that predates timestamp persistence — cannot be judged. They are allowed by default so the guard can be switched on in front of a mixed fleet. Once every writer is known to send the header, `--stale-write-on-missing-base deny` closes the gap.

> Like every other check here, this is only an enforcement boundary if direct access to the n8n API is blocked at the network level. A caller that can reach n8n directly bypasses the proxy entirely.

> **Do not combine this with `--tags`.** The tag filter reads tags from the request body, and the body `apply` sends carries `name`, `nodes`, `connections`, `settings` and `staticData` — no tags. Every write from `n8n-cli` therefore falls outside any tag scope and is forwarded without running middleware at all. Since `n8n-cli` is the only client that sends a base revision, `--tags` and `--stale-write-enforce error` together leave the guard doing nothing. The same is true of lint; see the note under [Scoping by tags](#proxy).

**Scoping by tags:** pass `--tags managed,prod` (or set `PROXY_FILTER_BY_TAGS`) to constrain middleware enforcement to workflow saves whose `tags` contain every listed name. Saves outside that scope are forwarded transparently — no lint, no duplicate-name check, no authz. Useful when only a subset of workflows on the upstream is under policy. Filtering is AND across the listed names.

> **Scope is advisory, not an enforcement boundary.** The filter reads tags from the request body the client sent, not from the existing upstream workflow, so a caller can bypass middleware by stripping the tag from the JSON they submit. Use it to opt subsets of workflows into policy (organizational scoping), not to defend against a hostile client; for hard enforcement keep the filter empty so every save is checked, or pair the filter with API-key / network-level access controls.

#### MCP gating

<a id="mcp-gating"></a>

n8n's instance-level MCP server publishes one fixed set of tools — search, execute, publish, archive, workflow authoring, agent authoring, credentials, data tables — and `search_workflows` lists every workflow the connecting user can see. Whether an agent may *run* a given workflow is a per-workflow `Available in MCP` toggle, set in the n8n UI by anyone with edit rights, invisible in review, and dropped by the public API before v2.17.0.

How much of that tool set a client gets depends on how it authenticated. An OAuth2 client is granted scopes and n8n narrows the tools to match. **A static MCP access token carries no scopes, and n8n reads that as "every tool"** — including `create_workflow_from_code`, `update_workflow`, `archive_workflow`, the agent-authoring tools and `list_credentials`. A proxy holding one token on behalf of its callers is therefore holding the unrestricted variant, and the allowlist below is the only thing narrowing it.

That is a reasonable product default and a poor blast radius. The MCP gate puts the operator's own answer in front of it, where a workflow author cannot change it:

```bash
n8n-cli proxy \
  --upstream https://n8n.example.com \
  --client-middleware api-key-inject \
  --api-key-inject-key-env-var N8N_API_KEY \
  --mcp-enforce error \
  --mcp-allow-tools 'search_workflows,get_workflow_details,execute_workflow' \
  --mcp-workflow-tags mcp \
  --mcp-entry-path-pattern '__mcp__/*'
```

> **The gate needs its own credential for the public API.** Deciding whether a workflow is in scope means reading `/api/v1/workflows`, and an MCP client authenticates to the *MCP* endpoint — nothing on its request carries an `X-N8N-API-KEY`. So the egress chain has to supply one, unscoped (`api-key-inject`), or every workflow-scoped call is refused with "could not verify whether that workflow is available over MCP". A 401 on that lookup says so explicitly in the log.

**A workflow is never a tool here.** Under instance-level MCP the tools are verbs — `search_workflows`, `execute_workflow`, `update_workflow` — and a workflow is an *argument* to one. So the gate has two independent axes: which verbs a client gets, and which workflows those verbs may name.

Four things happen, and only the first is cosmetic:

1. **`tools/list` is filtered** — a withheld verb never reaches the model's context.
2. **`tools/call` on a withheld verb is refused at the proxy**, and never reaches n8n. Hiding a tool an agent can still call is theatre; the refusal comes back as a JSON-RPC `Unknown tool` error.
3. **`tools/call` naming a workflow outside the scope is refused**, with an MCP tool result carrying `isError: true` and the reason — which tag is missing, or which trigger n8n would have entered it through. The agent is told *why* rather than seeing a transport failure.
4. **`search_workflows` is narrowed rather than refused**, so that what an agent can see and what it can run are the same set. Its results are filtered on the way back against the same policy that governs `tools/call` — by tag, by entry path, or both. Where the policy has tags, they are also merged into the request's own `tags` argument (an AND, the same semantics), which saves n8n from serving rows that would be dropped anyway.

Everything else on the path — `initialize`, notifications, the server-to-client `GET` stream, session teardown — is forwarded untouched, and both `application/json` and `text/event-stream` (Streamable HTTP) replies are handled.

| Flag | Env | Description |
|------|-----|-------------|
| `--mcp-enforce <level>` | `N8N_MCP_ENFORCE` | `off`, `warn`, `error`. **Required to enable the gate** — without it `/mcp-server/` is forwarded unfiltered, so upgrading changes nothing |
| `--mcp-allow-tools <list>` | `N8N_MCP_ALLOW_TOOLS` | Comma-separated `*`-globs; only these **verbs** are visible and callable. Empty means all |
| `--mcp-deny-tools <list>` | `N8N_MCP_DENY_TOOLS` | Globs to withhold, applied after the allowlist |
| `--mcp-workflow-tags <tags>` | `N8N_MCP_WORKFLOW_TAGS` | A reachable workflow must carry **all** of these tags. Also narrows `search_workflows` |
| `--mcp-entry-path-pattern <glob>` | `N8N_MCP_ENTRY_PATH_PATTERN` | A reachable workflow's **entry trigger** must declare a path matching this glob (see below) |
| `--mcp-cache-ttl-ms <ms>` | `N8N_MCP_CACHE_TTL_MS` | Workflow-facts cache lifetime (default `60000`) |

### The entry trigger

`execute_workflow` does not let the caller choose a trigger. n8n maps the supplied input onto **the first non-disabled Schedule / Webhook / Form / Chat node in the workflow's `nodes` array** and starts there — array order decides, and its own source calls the multi-trigger case unsupported. Node order is invisible in a diff, so a workflow can be exposed exactly as intended and still be entered through a test hook, or through a nightly Schedule.

`--mcp-entry-path-pattern` gates on the path *that* trigger declares. It lets a repository mark "this workflow has an interface meant for agents" in the workflow itself, while the proxy stays agnostic about which trigger type was used to build it:

- A **Schedule** trigger carries no path, so a cron job cannot opt itself in by accident.
- A webhook or form node that never had a path set carries none either — n8n falls back to the node's `webhookId`. Declaring the path is what opts a workflow in, so the rule fails closed.
- Matching happens against the *first* supported trigger, not any of them, precisely so that this and n8n agree about which node runs.

The matching mirrors n8n's `findMcpSupportedTrigger`. That is a coupling: if n8n adds a supported trigger type, a workflow whose new-type trigger sorts earlier is entered somewhere this release does not predict. The list lives in one place (`src/common/mcp.ts`) and is worth revisiting on an n8n upgrade. The [`mcp-exposure`](#mcp-exposure) lint rule takes the same glob, so CI and the gate cannot disagree.

> **`fmt` re-derives node order from position.** `n8n-cli fmt` writes nodes sorted by canvas position (left to right, then top to bottom), so on a formatted workflow the entry is whichever matching trigger sits leftmost — not whichever appears first in the file you edited. It also recomputes those positions with a graph layout, which places every trigger in the same column and orders them by a heuristic you do not control. Two ways out: keep the agent-facing trigger's path unique so the lint rule catches any drift on the next PR, or keep MCP-exposed definitions in a format `fmt` does not touch (`.ts`, where node order is explicit). `fmt` does not know about this glob today.

### `get_workflow_entry` — a tool the proxy adds

`execute_workflow`'s own description tells the model to call `get_workflow_details` first, and it has to: `inputs` is a union discriminated by trigger type (`chat` / `form` / `webhook`), nothing in `search_workflows` says which one a workflow takes, and picking wrong makes n8n execute with empty data rather than fail. So that lookup runs before every execution — and n8n answers it with the whole workflow definition. Measured against a live instance, one workflow came back as **116 KB**, of which a caller that only runs workflows reads three fields.

Name `get_workflow_entry` in `--mcp-allow-tools` and the gate publishes a small tool of its own beside n8n's:

```json
{ "id": "...", "name": "...", "description": "...", "tags": [],
  "entry": { "name": "[MCP] entry", "type": "n8n-nodes-base.formTrigger",
             "path": "__mcp__/...", "parameters": { "formFields": {} } } }
```

`entry` is resolved exactly as reachability is, so the trigger reported is the node n8n would start from, and its `parameters` carry what building `inputs` needs — a form trigger's `formFields`, a webhook's `httpMethod`.

The description costs one `GET /api/v1/workflows/{id}`, once per workflow per cache lifetime, and only for a workflow the policy already allows: n8n's workflow *listing* — which is what the gate's index is built from — omits `description` entirely, and only the per-workflow read carries it. If that read fails the tool still answers, without the description: the trigger information is the part a caller cannot get anywhere else.

**It adds, it does not rewrite.** n8n's `get_workflow_details` keeps behaving exactly as n8n serves it; an operator who wants only the small one leaves the large one out of the allowlist. Nothing here makes this proxy responsible for a response shape it does not own. The trigger half costs no upstream call at all — resolving the entry trigger is already how the gate decides reachability. The same scope applies: a workflow outside the policy is refused with the reason, not described.

It must be named in `--mcp-allow-tools` rather than merely permitted by an empty one, so upgrading the proxy never adds a tool to a client's list on its own.

**Rollout:** `--mcp-enforce warn` logs every decision and changes nothing — the tool list is *not* filtered in warn mode either, because a client that never sees a tool cannot exercise it and the log you are rolling out against would stay empty.

**Fail-closed.** A tool call whose workflow cannot be resolved — because the upstream list is unreadable — is refused, as is a workflow-scoped call that names no workflow. There is no switch to open those: a gate that opens during an outage is not a gate, and `warn` already covers "measure, don't block".

**Cost of the tag lookup.** Resolving tags means walking every page of `/api/v1/workflows`, which on an instance with thousands of workflows is seconds. The gate starts that fetch at startup instead of inside the first tool call, and a call that arrives while it is still running joins it rather than starting a second one. The prefetch is *not* part of the readiness pass: a deployment whose startup probe reads `/readyz` would otherwise be held back for as long as a slow n8n takes, which is a worse failure than the latency it avoids. After that the index is refreshed on the first call past `--mcp-cache-ttl-ms`; raise the TTL if that refresh shows up in your latency.

**Deliberately not options.** The endpoint path is fixed at `/mcp-server/`, because n8n fixes it and a flag would only be a way to point the gate at the wrong path and quietly stop gating. And the gate does not re-check `settings.availableInMCP`: n8n already refuses `execute_workflow` and `get_workflow_details` for a workflow without it, so the check would add configuration and no enforcement. Use the tag for what n8n's toggle cannot give you — a decision that shows up in review.

**Which tools take a workflow id.** A built-in table covers the workflow-scoped tools — `execute_workflow`, `test_workflow`, `prepare_workflow_pin_data`, `get_workflow_details`, `get_workflow_history`, `get_workflow_version`, `restore_workflow_version`, `update_workflow`, `publish_workflow`, `unpublish_workflow`, `archive_workflow` — reading `workflowId` and then `id`. It is not configurable and it is not the only check: the gate separately scans **every** argument value, nested ones included, against the set of workflow ids that exist upstream. So a tool n8n renames, a parameter this release read wrong, or a tool it has never heard of cannot carry a forbidden workflow id past the gate — the table only decides how precise the refusal message is, and whether a call that names no workflow at all is refused.

> **Build `--mcp-allow-tools` from a real `tools/list` against your own instance.** n8n renames these tools between versions — a 2.32.5 instance serves `list_tags`, `get_execution`, `search_executions` and `prepare_test_pin_data`, where later code renames them to `list_workflow_tags`, `get_workflow_execution`, `search_workflow_executions` and `prepare_workflow_pin_data`. Neither the documentation nor a checkout of n8n's default branch tells you which set *your* server publishes. A name that does not exist costs nothing; a real tool missing from the allowlist is silently withheld, so listing both spellings is the safe move.

**What it does not do:** only `search_workflows` is filtered on the way back. The execution-history tools (`search_executions`, `get_execution`) report on workflows the policy does not expose, so withhold them unless that history is meant to be readable. And `count` in a filtered page is the number of rows that survived, not n8n's total: n8n reports the total number of matches, so passing it through would tell the model to keep paging after rows it will never be shown, and roughly how many workflows are being withheld. It therefore reads as a floor rather than a total.

> As with every other check here, this is an enforcement boundary only if direct access to n8n is blocked at the network level. A client that can reach `/mcp-server/` on the instance itself bypasses the proxy.

The repository-side half of this — deciding which workflows *should* be exposed, and making sure they carry a description worth reading — is the [`mcp-exposure`](#mcp-exposure) and [`mcp-tool-description`](#mcp-tool-description) lint rules.

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

## TypeScript workflow definitions

Workflows can be stored as `.ts` files written against
[`@n8n/workflow-sdk`](https://www.npmjs.com/package/@n8n/workflow-sdk), giving you
type-checked, reviewable workflow definitions alongside — or instead of — JSON and
YAML.

```bash
# Author a .ts workflow, then deploy it
n8n-cli apply --ts --ids wf-100 -d ./definitions

# Pull workflows down as .ts
n8n-cli import --ts -d ./definitions

# Convert existing JSON/YAML definitions to .ts
n8n-cli convert --format ts -d ./definitions

# Go back the other way. Directory scans need --ts to look at .ts at all;
# an explicit file path is always honoured.
n8n-cli convert --format json -d ./definitions --ts
n8n-cli convert --format json ./definitions/orders__wf-100.ts
```

`apply` skips `.ts` files unless the format is enabled, so unrelated TypeScript
sitting in a definitions directory is never parsed as a workflow. Enable it
per-invocation with `--ts`, or project-wide via the `TypeScript Mode` row in
CLAUDE.md.

`import` behaves like it does for YAML: `--ts` chooses the format for workflows
being written for the first time, while an existing `.ts` file is always
recognised and updated in place, so a workflow never silently switches format.

Importing a workflow whose local `.ts` file is already up to date is skipped
entirely — the generated `meta.updatedAt` records the upstream timestamp, so your
comments, variable names and formatting are left alone.

### Mixing formats safely

JSON, YAML and `.ts` can coexist in one directory. Every file, whatever its
format, is resolved to the same internal workflow representation and then checked
for duplicate workflow IDs — so a workflow accidentally defined twice in two
different formats is reported as an error rather than one silently winning:

```
Error: duplicate workflow ID: wf-100
  Files:
    - definitions/orders__wf-100.json
    - definitions/orders__wf-100.ts
```

A `.ts` file that fails to parse is reported against that file alone; the rest of
the directory still applies.

### File format

```typescript
import { workflow, trigger, node } from "@n8n/workflow-sdk";

// Optional. Carries the fields the SDK has no representation for.
export const meta = {
  active: true,
  tags: ["managed-as-code"],
  // The workflow's top-level description. See "Workflow description" below.
  description: "Looks up a hospital by name and returns its contract status.",
  // Written by n8n-cli when it generates the file; keeps node IDs and the
  // import skip-check stable. Optional in hand-written files.
  nodeIds: { Trigger: "a1b2c3d4-...", Set: "e5f6a7b8-..." },
  updatedAt: "2026-08-07T00:00:00.000Z",
};

const start = trigger({
  type: "n8n-nodes-base.manualTrigger",
  version: 1,
  config: { name: "Trigger" },
});

const set = node({
  type: "n8n-nodes-base.set",
  version: 3.4,
  config: { name: "Set", parameters: { value: "={{ $json.x }}" } },
});

const wf = workflow("wf-100", "My workflow");

export default wf.add(start).to(set);
```

Install the SDK in your definitions repository (`bun add -d @n8n/workflow-sdk`) to
get editor type-checking. n8n-cli does **not** need it installed — the parser is
bundled into the binary.

### How it is parsed

`.ts` workflows are **never executed**. n8n-cli strips TypeScript syntax and the
module imports, then hands the result to the SDK's AST interpreter, which
evaluates a small whitelist of SDK calls without `eval()` or `new Function()`.
A workflow file cannot read your environment, touch the filesystem, or make
network calls.

### Limitations

The accepted subset is deliberately narrow — it is a declarative format that
happens to be valid TypeScript, not a general program:

- only `const` declarations, expression statements and a single `export default`
- no `let`/`var`, destructuring, loops, conditionals, or function definitions
- no importing shared helpers from other files (imports are stripped, not resolved)
- `export const meta` must be an object literal of static values, declared on its
  own rather than sharing a statement with another export

Two further consequences of the SDK's data model:

- **Node IDs live in `meta.nodeIds`.** The SDK's builder has no field for a node
  ID and mints a random one on every parse, so generated files record them
  explicitly. Hand-written files that omit them get IDs derived deterministically
  from the workflow ID and node name, and `apply` adopts whatever IDs upstream
  already uses for the same node names — so IDs never churn.
- **Conversion to `.ts` is verified.** `convert --format ts` and `import --ts`
  parse the generated file back and compare name, nodes, connections, settings,
  pinData and staticData against the source. A workflow the SDK cannot represent
  faithfully — one carrying `staticData`, for instance — fails loudly, naming the
  node and field, rather than producing a subtly wrong file.

Other commands are unaffected by `.ts`: `lint` and `fmt` still read JSON and YAML
only, so ordinary TypeScript in a definitions directory is never mistaken for a
workflow. `apply` still lints `.ts` workflows before writing them upstream.

`apply` does not update `meta.updatedAt` after a successful write (the same is
true of YAML), so editing and re-applying a workflow that changed upstream in the
meantime reports a conflict and needs `--force`.


## Workflow description and MCP exposure

A workflow carries a top-level `description` — free text, distinct from the
`description.md` `import` writes into `_subfiles/` as local documentation, and
distinct from a node's `notes`. `import` brings it down, `apply` pushes it back,
and it round-trips through JSON, YAML and `.ts` (in the `meta` block, since the
SDK has no field for it).

It is worth writing carefully when the workflow is reachable over n8n's
instance-level MCP server, because that is where the text is read: n8n shows it
to a connected agent in `search_workflows` results and in `get_workflow_details`,
so it is effectively the tool description the model uses to decide whether to
call the workflow. n8n truncates it at 255 characters from v2.27.0.

Whether a workflow is reachable at all is `settings.availableInMCP` — the
`Available in MCP` toggle in n8n's workflow settings. n8n-cli treats it as an
ordinary setting: imported, diffed and applied like the rest. Two caveats:

- n8n's public API silently dropped it on write until **v2.17.0**
  ([n8n-io/n8n#27914](https://github.com/n8n-io/n8n/pull/27914)). Against an older
  server the value round-trips into your definitions and is then discarded on
  apply, so the toggle has to be set in the UI there.
- `search_workflows` lists every workflow the connecting user can see, whether or
  not it is MCP-enabled; the toggle only gates `get_workflow_details` and
  `execute_workflow`. To decide what an agent may reach independently of that,
  put the [`mcp` gate](#mcp-gating) in front of n8n.

`apply` only sends `description` when the local definition has one, so a
definition that never carried one is unaffected — which matters against an n8n
old enough to reject unknown properties outright. A definition with no
`description` key is treated as not managing the field: it is not diffed against
whatever is upstream, so a description written in the n8n UI is left alone until
`import` brings it down. Write `description: ""` to clear one deliberately.

The [`mcp-tool-description`](#mcp-tool-description) and
[`mcp-exposure`](#mcp-exposure) lint rules turn all of this into something CI can
check.

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
| `N8N_STALE_WRITE_ENFORCE` | Stale-write guard level: `off` (default), `warn`, `error` |
| `N8N_STALE_WRITE_ON_MISSING_BASE` | Callers that declare no base revision: `allow` (default) or `deny` |
| `N8N_STALE_WRITE_ON_ERROR` | When the stored workflow cannot be read: `deny` (default) or `allow` |
| `N8N_STALE_WRITE_ACTIONS` | Comma-separated route actions the guard applies to (default: `update`) |

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
(`X-Impersonator-Id-Token`; sources `adc`, `env`, `static`), `api-key-inject`,
`webhook-token-inject`, `bearer-token-inject`.

Each middleware declares the headers it supplies, and on which paths. Where the
chain supplies a credential header for the request at hand, the `Authorization`
the caller sent is dropped before the chain runs. That header addresses the
proxy hop, not n8n: it is a credential for reaching the proxy, replayable until
it expires, and forwarding it would leak the right to call the proxy into the
upstream's logs. Where the upstream sits behind its own identity-aware proxy it
would also carry the wrong `aud` and only produce 401s at the second hop.
Middlewares run after the drop and only ever add headers, so the result does not
depend on chain order.

Everything else keeps forwarding `Authorization` untouched, because nothing in
front of it consumed the header and webhook nodes using header or basic auth
rely on it arriving: a chain of `api-key-inject` alone, no chain at all, or —
when the chain's only credential claims are path-scoped — a path none of those
rules covers. Note the scope of each: `iap-auth` claims its header on **every**
path, so a chain containing it drops the caller's `Authorization` everywhere;
`bearer-token-inject` and `webhook-token-inject` claim only where their rules
match.

Two middlewares wanting the same header on paths that can overlap — `iap-auth`
in its default mode alongside `bearer-token-inject`, say — is refused when the
proxy starts, rather than letting chain order decide which credential reaches
n8n. Claims over prefixes that cannot both match one request are fine.

#### webhook-token-inject

Webhook nodes can require a shared secret in a header. `webhook-token-inject`
lets the proxy hold those secrets instead of every caller, so a caller that has
already authenticated to the proxy needs nothing else to fire a webhook — while
a request arriving through some other ingress still carries no token and is
rejected by n8n.

Rules are path-scoped, because a webhook token is not a gateway credential: it
is the secret one specific family of webhook nodes checks. Injecting it on every
upstream call would mean anyone able to reach the proxy could satisfy that
header wherever it happens to be checked.

```bash
export N8N_CLIENT_MIDDLEWARES="iap-auth,api-key-inject,webhook-token-inject"
export N8N_WEBHOOK_TOKEN_INJECT_RULES='[
  {"pathPrefix":"/webhook/ops-triggers/","header":"x-ops-trigger-token","tokenEnvVar":"OPS_TRIGGER_TOKEN"},
  {"pathPrefix":"/webhook/smoke-tests/","header":"x-smoke-test-token","tokenEnvVar":"SMOKE_TEST_TOKEN"}
]'
export OPS_TRIGGER_TOKEN="..."   # typically mounted from a secret store
export SMOKE_TEST_TOKEN="..."
```

| Field | Required | Notes |
| --- | --- | --- |
| `pathPrefix` | yes | Matched against the incoming pathname. Keep the trailing slash — `/webhook/ops` would also match `/webhook/opsx`. |
| `header` | yes | Any valid HTTP header name. |
| `tokenEnvVar` | either this | Name of an env var holding the token. Preferred: the rule set itself travels through env/CLI, where a literal would land in process listings and config dumps. |
| `token` | or this | Literal value, for deployments that already render config from a secret store. |
| `conflictPolicy` | no | `set-if-absent` (default) keeps a token the caller brought, which eases migration; `replace` makes the proxy the single holder. |

Every matching rule is applied, not just the first, so a broad rule can be
combined with narrower ones; when two matching rules share a header the later
one decides. A rule naming an unset `tokenEnvVar` fails at startup rather than
silently injecting nothing.

#### bearer-token-inject — reaching an app that wants `Authorization` for itself

n8n's instance-level MCP server (`POST /mcp-server/http`) authenticates with
`Authorization: Bearer <token>`. Behind Google IAP that header is already taken:
IAP authenticates with `Authorization`, consumes it, and never passes it to the
backend — so the application sees no token and answers
`401 Unauthorized: Authorization header not sent`.

IAP documents the way out. When a valid id_token arrives in
`Proxy-Authorization`, IAP authorizes on that header instead and forwards
`Authorization` to the backend without reading it
([Authenticating from a proxy-authorization header](https://docs.cloud.google.com/iap/docs/authentication-howto#authenticating_from_proxy-authorization_header)).
So set `iap-auth` to write its id_token to `Proxy-Authorization`, and let
`bearer-token-inject` put the application's token in `Authorization`:

| Header | Carries | Consumed by |
| --- | --- | --- |
| `Proxy-Authorization` | the gateway id_token | IAP |
| `Authorization` | the application token | n8n |

The switch is deployment-wide rather than path-scoped: n8n's public API
authenticates on `X-N8N-API-KEY` and never reads `Authorization`, so freeing that
header up costs it nothing, and one setting is easier to reason about — and to
revert — than a per-path rule.

```bash
export N8N_CLIENT_MIDDLEWARES="iap-auth,api-key-inject,bearer-token-inject"
export N8N_IAP_AUTH_HEADER_NAME="proxy-authorization"
export N8N_BEARER_TOKEN_INJECT_RULES='[
  {"pathPrefix":"/mcp-server/","tokenEnvVar":"N8N_MCP_TOKEN"}
]'
export N8N_MCP_TOKEN="..."   # typically mounted from a secret store
```

| Env | CLI | Notes |
| --- | --- | --- |
| `N8N_IAP_AUTH_HEADER_NAME` | `--iap-auth-header-name` | `authorization` (default, unchanged behavior) or `proxy-authorization`. |
| `N8N_BEARER_TOKEN_INJECT_RULES` | `--bearer-token-inject-rules` | JSON array of rules, see below. |

| Field | Required | Notes |
| --- | --- | --- |
| `pathPrefix` | yes | Matched against the incoming pathname. Keep the trailing slash — `/mcp-server` would also match `/mcp-server-admin`. |
| `tokenEnvVar` | either this | Name of an env var holding the token. Preferred, for the same reason as in `webhook-token-inject`. |
| `token` | or this | Literal value, for deployments that already render config from a secret store. |
| `scheme` | no | Auth scheme prefixed to the token, `Bearer` by default. An empty string writes the raw value. |

Rules are path-scoped because the token is one application surface's credential,
not a gateway credential: injected everywhere, it would be handed to every
endpoint the proxy can reach. This middleware writes nothing on paths no rule
covers — in the configuration above `iap-auth` still clears the caller's
`Authorization` there, so those requests reach n8n without one; run
`bearer-token-inject` on its own and a path outside its rules keeps whatever the
caller sent.

`Proxy-Authorization` remains on the hop-by-hop strip list (RFC 7230 §6.1), so a
caller cannot smuggle its own gateway token through — only the token the proxy
mints reaches IAP. Reverting is one env var: unset `N8N_IAP_AUTH_HEADER_NAME`
and the id_token goes back to `Authorization`.

**This assumes something authenticates callers in front of the proxy.** Unlike a
webhook token, an MCP token is a general-purpose credential for the instance, and
`/mcp-server/` is transparently forwarded, so it never passes through the
server-middleware chain — anyone who can open a connection to the proxy's port
gets the token attached on their behalf. Deploy the proxy behind IAP (or an
equivalent ingress that authenticates every request) and do not expose its port
directly.

### CLAUDE.md Integration

n8n-cli can read project settings from a `CLAUDE.md` file in your repository:

- **Default project ID** - Automatically set the target project for apply
- **Auto tags** - Tags to automatically add to deployed workflows
- **YAML mode** - Enable/disable YAML processing by default
- **TypeScript mode** - Enable/disable `.ts` processing by default (table key: `TypeScript モード`, `TypeScript Mode` or `tsEnabled`)
- **Externalize threshold** - Minimum lines for code externalization during import

## Documentation

See the `docs/` directory for additional documentation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build instructions, and contribution guidelines.

## License

n8n-cli's own source code is licensed under the MIT License — see the [LICENSE](LICENSE) file.

The distributed **binary is an aggregate work**. `bun build --compile` links every
production dependency into the executable, and those dependencies keep their own
licenses; the MIT license above covers only n8n-cli's own code and does not
relicense them.

In particular, the bundled n8n packages — including `n8n-workflow` and
`@n8n/workflow-sdk` — are distributed under the
[n8n Sustainable Use License](https://docs.n8n.io/privacy-and-security/sustainable-use-license),
which is a source-available license, not a permissive one. Its Notices clause
requires that anyone receiving a copy of the software also receives a copy of its
terms, so [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) lists every bundled
dependency with its license text and is attached to each GitHub release.

That file is generated from the lockfile and verified in CI:

```bash
bun run generate-third-party-licenses   # regenerate after changing dependencies
bun run check-third-party-licenses      # fail if it is out of date
```
