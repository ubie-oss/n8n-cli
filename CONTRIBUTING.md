# Contributing to n8n-cli

Thank you for your interest in contributing to n8n-cli! This guide covers the development workflow.

## Development Environment Setup

### Prerequisites

- [Bun](https://bun.sh/) v1.0 or later
- [Git](https://git-scm.com/)

### Getting Started

```bash
git clone https://github.com/ubie-oss/n8n-cli.git
cd n8n-cli
bun install
```

## Project Structure

```
n8n-cli/
├── src/
│   ├── index.ts          # Entry point
│   ├── api/              # n8n API client and services
│   ├── apply/            # Apply command logic
│   ├── cli/              # CLI commands and output formatters
│   ├── common/           # Shared utilities
│   ├── config/           # Configuration loading
│   ├── formatter/        # Workflow formatting
│   ├── git/              # Git integration
│   ├── importer/         # Import command logic
│   ├── input/            # Input file handling
│   ├── lint/             # Linter rules and output
│   ├── naming/           # File naming conventions
│   ├── test/             # Test command logic
│   └── yaml/             # YAML processing
├── tests/                # Test files (mirrors src/ structure)
├── Makefile              # Build and development tasks
├── biome.json            # Linter and formatter configuration
└── tsconfig.json         # TypeScript configuration
```

## Build

Build the standalone binary:

```bash
make build
```

The binary is output as `./n8n-cli` in the project root.

For cross-platform builds:

```bash
make cross-compile
```

## Running Tests

```bash
# Run all tests
make test

# Or directly with Bun
bun test

# Run a specific test file
bun test tests/lint/rules/some-rule.test.ts
```

## Type Checking

```bash
make typecheck
```

## Lint and Format

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

```bash
# Check for lint errors
make lint

# Auto-format code
make format
```

### Biome Configuration

- Indent: 2 spaces
- Line width: 100 characters
- See `biome.json` for full configuration

## Commit Message Convention

Use clear, descriptive commit messages:

```
<type>: <short description>

<optional body>
```

Types:
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code restructuring without behavior change
- `docs` - Documentation only
- `test` - Adding or updating tests
- `chore` - Build process, tooling, or dependency updates

Examples:
```
feat: add --tags filter to import command
fix: handle empty workflow list in apply
docs: update README with new CLI options
```

## Creating a Pull Request

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and ensure all checks pass:
   ```bash
   make lint
   make typecheck
   make test
   ```

3. Push your branch and open a PR against `main`.

4. Provide a clear description of your changes in the PR body.

## Code Style

- TypeScript with strict mode enabled
- Use `@/` path alias for imports from `src/`
- Prefer descriptive variable and function names
- Keep functions focused and small

## Adding a New Command

1. Create a new file in `src/cli/commands/`
2. Export a `registerXxxCommand(program: Command)` function
3. Register it in `src/index.ts`
4. Add corresponding tests in `tests/`

## Adding a New Lint Rule

1. Create a new rule file in `src/lint/rules/`
2. Implement the `LintRule` interface
3. Register it in `src/lint/rules/index.ts`
4. Add tests in `tests/lint/`
