# syntax=docker/dockerfile:1.7

# ---- build stage --------------------------------------------------------
# Bun ships a `--compile` mode that produces a self-contained native binary,
# so the runtime image only needs the resulting file. Two stages keep the
# final image tiny (< 100MB) with no bun toolchain / node_modules baggage.
#
# Both stages MUST agree on libc. Bun-compiled binaries are dynamically
# linked to the C library of the build image — mixing an Alpine (musl)
# build with a Debian (glibc) runtime yields a binary the runtime's
# loader can't find, and Cloud Run cold-starts crash-loop with
# `exec /app/n8n-cli: no such file or directory`. Use the Debian bun
# base to match the distroless/base-debian12 runtime below.

FROM oven/bun:1.3.4-debian AS build

WORKDIR /src

# Install dependencies first for better layer caching.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Pull in the rest of the source. `bun run build` runs `generate-schemas`
# then `bun build --compile` (see package.json).
COPY . .
RUN bun run build

# ---- runtime stage ------------------------------------------------------
# distroless keeps the surface small; the compiled binary needs libstdc++
# and glibc, hence the debian-slim variant of distroless (not static).

FROM gcr.io/distroless/base-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=build /src/n8n-cli /app/n8n-cli

# Cloud Run passes PORT via env; the proxy honors --listen :$PORT via the
# default value. Callers that need a specific port can override at deploy
# time with `args` on the Cloud Run service.
EXPOSE 8080

USER nonroot:nonroot

ENTRYPOINT ["/app/n8n-cli"]
CMD ["proxy"]
