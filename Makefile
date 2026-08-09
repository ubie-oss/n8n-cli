.PHONY: all generate-schemas third-party-licenses check-third-party-licenses build cross-compile test test-integration typecheck lint format size-check quality-gate clean

all: build

# Detect biome binary (handle Rosetta x64/arm64 mismatch)
BIOME := $(shell command -v biome 2>/dev/null || \
	([ -f node_modules/@biomejs/cli-darwin-arm64/biome ] && echo node_modules/@biomejs/cli-darwin-arm64/biome) || \
	([ -f node_modules/@biomejs/cli-linux-x64/biome ] && echo node_modules/@biomejs/cli-linux-x64/biome) || \
	echo "bunx biome")

CLI_VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
CLI_GIT_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
CLI_BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

DEFINE_FLAGS = \
	--define "CLI_VERSION='$(CLI_VERSION)'" \
	--define "CLI_GIT_COMMIT='$(CLI_GIT_COMMIT)'" \
	--define "CLI_BUILD_DATE='$(CLI_BUILD_DATE)'"

generate-schemas:
	bun run scripts/generate-schemas.ts

# The compiled binary links every production dependency, several of which are
# under the n8n Sustainable Use License. Its Notices clause requires shipping the
# terms alongside the binary, so this file is attached to every release.
third-party-licenses:
	bun run scripts/generate-third-party-licenses.ts

check-third-party-licenses:
	bun run scripts/generate-third-party-licenses.ts --check

build: generate-schemas
	bun build src/index.ts --compile --outfile n8n-cli --minify $(DEFINE_FLAGS)

cross-compile:
	bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/n8n-cli-darwin-arm64 --minify $(DEFINE_FLAGS)
	bun build src/index.ts --compile --target=bun-darwin-x64 --outfile dist/n8n-cli-darwin-x64 --minify $(DEFINE_FLAGS)
	bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/n8n-cli-linux-x64 --minify $(DEFINE_FLAGS)
	bun build src/index.ts --compile --target=bun-windows-x64 --outfile dist/n8n-cli-windows-x64 --minify $(DEFINE_FLAGS)

test:
	bun test

test-integration:
	bun test tests/cli/

typecheck:
	bunx tsc --noEmit

lint:
	$(BIOME) check src/ tests/

format:
	$(BIOME) format --write src/ tests/

size-check:
	@size=$$(stat -f%z n8n-cli 2>/dev/null || stat -c%s n8n-cli 2>/dev/null); \
	limit=104857600; \
	if [ "$$size" -gt "$$limit" ]; then \
		echo "ERROR: Binary size $${size} bytes exceeds 100MB limit"; exit 1; \
	else \
		echo "OK: Binary size $${size} bytes (limit: $${limit})"; \
	fi

# Everything CI enforces, in one target so it can be run before pushing.
#
# `build` and `size-check` are in here because CI runs them and a gate that
# stops short of what CI enforces is not a gate. They also catch a class of
# problem the other targets structurally cannot: a dependency that type-checks
# and tests fine but does not survive `bun build --compile`, or one that pushes
# the shipped binary past the 100MB budget. Both only become visible once
# something is actually compiled.
quality-gate: generate-schemas typecheck lint check-third-party-licenses test build size-check

clean:
	rm -f n8n-cli
	rm -rf dist/
