---
name: n8n-cli-operations
description: Build and operation support for n8n-cli. Guides remote status checks, imports, dry-runs, apply, and linter execution. Auto-build recommended for new sessions.
allowed-tools: Read, Bash, Glob, Grep
---

# n8n-cli Operations Skill

A skill to assist with workflow management using n8n-cli (TypeScript/Bun).

## Session Initialization (Important)

**For new sessions, always run the following first to ensure n8n-cli is up to date.**

### Auto-Update from GitHub Releases (Preferred)

Pre-built binaries are available on GitHub Releases. This is faster than building from source and ensures you're running the official release.

```bash
# 1. Check the latest release version
LATEST_TAG=$(gh release view --repo ubie-oss/n8n-cli --json tagName -q '.tagName' 2>/dev/null)

# 2. Check current local version (if binary exists)
CURRENT_VERSION=""
if [ -x ./n8n-cli ]; then
  CURRENT_VERSION=$(./n8n-cli version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "")
fi

# 3. Compare and download if needed
if [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" != "$LATEST_TAG" ]; then
  echo "Updating n8n-cli: ${CURRENT_VERSION:-none} -> ${LATEST_TAG}"

  # Detect platform
  ARCH=$(uname -m)
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$ARCH" in
    arm64|aarch64) ASSET_NAME="n8n-cli-${OS}-arm64" ;;
    x86_64)        ASSET_NAME="n8n-cli-${OS}-x64" ;;
    *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
  esac

  # Download the binary
  gh release download "$LATEST_TAG" --repo ubie-oss/n8n-cli --pattern "$ASSET_NAME" --output n8n-cli --clobber
  chmod +x ./n8n-cli
  echo "Updated to $(./n8n-cli version 2>/dev/null | head -1)"
else
  echo "n8n-cli is up to date: $CURRENT_VERSION"
fi
```

### Fallback: Build from Source

If `gh` CLI is not available or you need a development build:

```bash
# Install dependencies + build CLI
bun install && make build
```

**Build verification:**
```bash
./n8n-cli version
```

## Environment Setup

### Checking the .env File

If `.env` exists at the project root, n8n-cli can be used without specifying parameters. **Do not read the contents.**

```bash
# Only check for .env existence (do not read contents)
test -f .env && echo ".env exists - n8n-cli can be used without parameters"
```

**If .env exists:**
- `N8N_API_URL` and `N8N_API_KEY` are already configured
- `./n8n-cli` can be run without parameters

**If .env does not exist:**
- Prompt the user to create a `.env` file
- Or use `--api-url` and `--api-key` flags

### Creating .env (Only If Needed)

```bash
cp .env.example .env
# Ask the user to edit
```

## Common Commands

### 1. Checking Remote Workflow Status

**Check a specific workflow:**
```bash
# Get workflow info by ID
./n8n-cli workflow get <workflow-id>

# Display in table format for readability
./n8n-cli -o table workflow get <workflow-id>

# Save to file (useful for diff comparison)
./n8n-cli workflow get <workflow-id> > /tmp/remote-workflow.json
```

**List workflows:**
```bash
# All workflows
./n8n-cli workflow list

# Table format
./n8n-cli -o table workflow list

# Active only
./n8n-cli workflow list --active
```

### 2. Import Workflows (Remote -> Local)

#### Check Local Format Before Importing

**When pulling remote content to local, always follow these steps:**

1. **Check local file format**
   ```bash
   # Check if file exists and its format
   ls -la definitions/*<workflow-id>* definitions/**/*<workflow-id>*

   # For jsonnet, also check for external files
   ls -la definitions/_subfiles/<workflow-id>/
   ```

2. **Use appropriate import options based on format**
   - `.json` files: use `--ids` only
   - `.jsonnet` files: use both `--ids` and `--yaml` (`--yaml` flag enables both YAML and Jsonnet)

**Import a specific workflow:**
```bash
# JSON format workflow
./n8n-cli import --ids=<workflow-id>

# Jsonnet format workflow (with external file splitting)
./n8n-cli import --ids=<workflow-id> --yaml

# To a custom directory
./n8n-cli import --ids=<workflow-id> -d ./my-dir
```

**Import multiple workflows:**
```bash
# Comma-separated list
./n8n-cli import --ids=abc123,def456,ghi789
```

**Import all workflows:**
```bash
./n8n-cli import
```

**Additional options:**

| Option | Description |
|--------|-------------|
| `--include-archived` | Include archived workflows |
| `--cleanup-orphans` | Delete orphan files without matching IDs |
| `-t, --threshold <int>` | Minimum lines for external file extraction (default: 0, configurable in CLAUDE.md) |
| `--dry-run` | Preview only (no file changes) |
| `--tags <tags>` | Filter by comma-separated tag names (AND condition) |

### 3. Dry-run (Change Preview)

**Always verify with dry-run before applying:**
```bash
# Preview changes for all workflows
./n8n-cli apply --dry-run

# Specific workflow only (by ID)
./n8n-cli apply --dry-run --ids=<workflow-id>

# Specific file only
./n8n-cli apply --dry-run -d definitions/path/to/workflow.json
```

**Example output:**
```
=== CREATE (1 workflow) ===
  + new-workflow.json (name: "New Automation")

=== UPDATE (2 workflows) ===
  ~ existing.json (id: R2cTI0LDzCJSnvNG)
    - name: "Old Name" -> "New Name"
    - nodes: 3 -> 5 nodes

=== SKIP (1 workflow) ===
  = unchanged.json (no changes)

Summary (dry-run): 1 to create, 2 to update, 1 unchanged
```

### 4. Apply (Deploy)

**AI assistants must always use --ids or specify a single file**

```bash
# Apply specific workflow only (recommended)
./n8n-cli apply --ids=<workflow-id>

# Apply specific file only
./n8n-cli apply -d definitions/path/to/workflow.json

# Force apply (overwrite remote changes)
./n8n-cli apply --ids=<workflow-id> --force
```

**Prohibited: Applying to an entire directory**
```bash
# These must NOT be run by AI
./n8n-cli apply -d definitions/
./n8n-cli apply
```

**Additional options:**

| Option | Description |
|--------|-------------|
| `--from-git-changes <spec>` | Apply only files changed in Git diff |
| `--yaml` / `--no-yaml` | Enable/disable YAML/Jsonnet processing |
| `--warn-duplicates` | Warn if a workflow with the same name already exists |
| `--no-auto-tag` | Disable automatic tagging (managed-as-code) |
| `-p, --project <id>` | Specify target project ID |

**Environment variables:**
- `APPLY_FILTER_BY_TAGS` - Filter by comma-separated tag names (AND condition)

**Git diff mode:**
```bash
# Apply only changes from a feature branch
./n8n-cli apply --from-git-changes origin/main..HEAD

# Preview
./n8n-cli apply --from-git-changes origin/main..HEAD --dry-run

# Changes from last 3 commits
./n8n-cli apply --from-git-changes HEAD~3..HEAD
```

3-way conflict detection: When `--from-git-changes` is specified, conflicts are detected by comparing Base (reference point), Local (current), and Remote (server) to identify only true conflicts.

### 5. Linter (Quality Checks)

**The linter is integrated into the CLI. No separate build needed.**

**Note: Positional arguments are not supported. Always specify files/directories with `-f` or `-d`.**

```bash
# Check a specific file (-f required)
./n8n-cli lint -f definitions/<filename>

# Check a specific directory
./n8n-cli lint -d ./definitions/example-project

# Check all workflows
./n8n-cli lint -d ./definitions

# JSON output (for CI/CD)
./n8n-cli lint -d ./definitions -o json
```

**Options:**

| Option | Description |
|--------|-------------|
| `-d, --dir <path>` | Definition files directory |
| `-f, --file <files...>` | Specific file(s) |
| `-c, --config <path>` | Config file path (.n8nlintrc.json) |
| `--disable-rule <name>` | Disable specific rule(s) |
| `--list-rules` | List all rules |
| `-o, --output <format>` | Output format: text, json (default: text) |

**Rules (10 rules):**

| Rule | Severity | Description |
|------|----------|-------------|
| `json-syntax` | error | JSON syntax check |
| `required-fields` | error | Required fields (name, nodes, connections) check |
| `connection-reference` | error | Connection target node existence check |
| `orphaned-node` | warning | Orphaned node detection |
| `implicit-json-ref` | warning | Implicit `$json` reference detection |
| `expression-mode-prefix` | warning | Missing `=` prefix detection |
| `ai-agent-output-ref` | warning | AI Agent output misreference detection |
| `node-params` | warning | Node parameter schema validation |
| `node-ref-field-check` | warning | Referenced field existence validation |
| `node-ref-cardinality` | warning | `.item`/`.first()` usage validation |

**Config file (.n8nlintrc.json):**

```json
{
  "rules": {
    "json-syntax": "error",
    "required-fields": "error",
    "orphaned-node": "warning",
    "implicit-json-ref": "off"
  }
}
```

Config file search order:
1. Path specified with `--config` flag
2. `.n8nlintrc.json` / `.n8nlintrc` in the target directory
3. `.n8nlintrc.json` / `.n8nlintrc` in the current directory

### 6. Test (Execution)

**Test workflows via test webhooks:**

```bash
# Basic test
./n8n-cli test <workflow-id>

# With test data
./n8n-cli test <workflow-id> -d '{"email": "test@example.com"}'

# Test data from file
./n8n-cli test <workflow-id> -f test-data.json

# Wait for execution to complete (recommended)
./n8n-cli test <workflow-id> --wait-execution

# Auto-activate inactive workflows
./n8n-cli test <workflow-id> --activate

# Check webhook URL only
./n8n-cli test <workflow-id> --dry-run

# Check input parameters
./n8n-cli test <workflow-id> --show-inputs
```

**Options:**

| Option | Description |
|--------|-------------|
| `-d, --data <json>` | Test data (JSON string) |
| `-f, --file <path>` | Test data file (JSON) |
| `--timeout <duration>` | HTTP timeout (default: 30s) |
| `--wait-execution` | Wait for execution to complete and show results |
| `--activate` | Auto-activate inactive workflows |
| `--dry-run` | Check webhook URL only |
| `--show-inputs` | Display input parameters |
| `-o, --output <fmt>` | Output format: text, json |

**Test from local file:**
```bash
# Specify a local JSON/Jsonnet file
./n8n-cli test ./definitions/my-workflow.json
```

### 7. Execution (Logs & Errors)

**List recent executions:**

```bash
# List all recent executions
./n8n-cli execution list

# Table format for readability
./n8n-cli -o table execution list

# Filter by status
./n8n-cli execution list --status error
./n8n-cli execution list --status success

# Filter by workflow
./n8n-cli execution list --workflow <workflow-id>

# Limit results
./n8n-cli execution list --limit 5

# Combined filters
./n8n-cli execution list --workflow <workflow-id> --status error --limit 10
```

**Get execution details:**

```bash
# Get execution by ID
./n8n-cli execution get <execution-id>

# Table format with error details
./n8n-cli -o table execution get <execution-id>

# Include node execution summary
./n8n-cli -o table execution get <execution-id> --show-data
```

**Options for `execution list`:**

| Option | Description |
|--------|-------------|
| `-w, --workflow <id>` | Filter by workflow ID |
| `-s, --status <status>` | Filter by status (success, error, running, waiting) |
| `-l, --limit <n>` | Maximum number of executions (default: 20) |

**Options for `execution get`:**

| Option | Description |
|--------|-------------|
| `--show-data` | Include node execution summary in output |

**Error information displayed:**

| Field | Description |
|-------|-------------|
| Error Node | The node where the error occurred |
| Error Message | The error message |
| Error Details | Additional error description (if available) |
| Last Node | The last executed node |

**Typical debugging workflow:**

```bash
# 1. List recent errors
./n8n-cli -o table execution list --status error --limit 5

# 2. Get details of a specific failed execution
./n8n-cli -o table execution get <execution-id> --show-data

# 3. Review error details and fix the workflow
```

## Typical Workflow Operations

### Editing Workflows

```bash
# 1. Update CLI (auto-update from GitHub Releases, fallback: bun install && make build)
LATEST_TAG=$(gh release view --repo ubie-oss/n8n-cli --json tagName -q '.tagName' 2>/dev/null)
CURRENT_VERSION=$(./n8n-cli version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "")
if [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" != "$LATEST_TAG" ]; then
  ARCH=$(uname -m); OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$ARCH" in arm64|aarch64) A="n8n-cli-${OS}-arm64";; x86_64) A="n8n-cli-${OS}-x64";; esac
  gh release download "$LATEST_TAG" --repo ubie-oss/n8n-cli --pattern "$A" --output n8n-cli --clobber && chmod +x ./n8n-cli
fi

# 2. Check .env
test -f .env && echo "OK"

# 3. Edit local file (using n8n-workflow skill)

# 4. Lint check
./n8n-cli lint -f definitions/<filename>

# 5. Dry-run to verify
./n8n-cli apply --dry-run --ids=<workflow-id>

# 6. Apply
./n8n-cli apply --ids=<workflow-id>

# 7. Post-apply dry-run to confirm results
./n8n-cli apply --dry-run --ids=<workflow-id>

# 8. Test (optional)
./n8n-cli test <workflow-id> --wait-execution
```

### Pulling Remote Changes

```bash
# 1. Check local file format (important!)
ls -la definitions/*<workflow-id>* definitions/**/*<workflow-id>*

# 2. Check for external files (for jsonnet)
ls -la definitions/_subfiles/<workflow-id>/ 2>/dev/null

# 3. Check remote state
./n8n-cli workflow get <workflow-id> > /tmp/remote.json

# 4. Compare with local (if needed)
diff definitions/path/to/workflow.json /tmp/remote.json

# 5. Import preserving format
# For JSON format:
./n8n-cli import --ids=<workflow-id>

# For Jsonnet format (external files will also be recreated):
./n8n-cli import --ids=<workflow-id> --yaml
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (invalid JSON, API error, network failure) |
| 2 | Conflict detected (dry-run only, when remote is newer) or rule violation (lint error) |

## Troubleshooting

### Authentication Error
```
Error: authentication failed
```
-> Check `N8N_API_KEY` in `.env`

### Network Error
```
Error: network error
```
-> Check `N8N_API_URL` in `.env`

### Conflict Error
```
Error: conflict: remote workflow has been modified since your local file
```
-> Check remote changes and either overwrite with `--force` or import and re-edit

## Guidelines for AI Assistants

### At Session Start

1. **Auto-update n8n-cli from GitHub Releases**
   ```bash
   # Check latest release and download if newer
   LATEST_TAG=$(gh release view --repo ubie-oss/n8n-cli --json tagName -q '.tagName' 2>/dev/null)
   CURRENT_VERSION=""
   if [ -x ./n8n-cli ]; then
     CURRENT_VERSION=$(./n8n-cli version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "")
   fi
   if [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" != "$LATEST_TAG" ]; then
     ARCH=$(uname -m); OS=$(uname -s | tr '[:upper:]' '[:lower:]')
     case "$ARCH" in
       arm64|aarch64) ASSET="n8n-cli-${OS}-arm64" ;;
       x86_64)        ASSET="n8n-cli-${OS}-x64" ;;
     esac
     gh release download "$LATEST_TAG" --repo ubie-oss/n8n-cli --pattern "$ASSET" --output n8n-cli --clobber && chmod +x ./n8n-cli
   fi
   ./n8n-cli version
   ```
   - `gh` CLI が使えない場合のフォールバック: `bun install && make build`

2. **Check .env existence** (do not read contents)
   ```bash
   test -f .env && echo ".env exists"
   ```

### After Editing Workflows (Development Feedback Loop)

1. **Lint check** - `./n8n-cli lint -f definitions/<filename>`
2. **Dry-run to verify changes** - `./n8n-cli apply --dry-run --ids=<workflow-id>`
3. **Proactively apply for testing** (always specify a single workflow)
   - Unless the user explicitly declines, apply even during development
   - After apply, share the n8n UI URL
   - If issues are found, repeat the fix -> apply cycle
4. **Post-apply dry-run** - Confirm no conflicts

### When Importing from Remote

**Important: Preserve the local format**

1. **Check local file format**
   ```bash
   ls -la definitions/*<workflow-id>* definitions/**/*<workflow-id>*
   ```

2. **Determine format**
   - `.json` -> JSON format
   - `.jsonnet` -> Jsonnet format (with external file splitting)

3. **Check for external files (for jsonnet)**
   ```bash
   ls -la definitions/_subfiles/<workflow-id>/
   ```

4. **Import with format-appropriate options**
   ```bash
   # JSON format
   ./n8n-cli import --ids=<workflow-id>

   # Jsonnet format
   ./n8n-cli import --ids=<workflow-id> --yaml
   ```

### Prohibited Actions

- Reading the contents of `.env` files
- Applying to an entire directory (always use `--ids` or specify a single file)
- Using `--force` carelessly
- **Importing without checking the local format first**
- **Overwriting jsonnet files with JSON format**
