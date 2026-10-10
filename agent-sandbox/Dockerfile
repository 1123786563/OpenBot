# The sandbox installs opencode at the version src/version.ts pins, and the Python the interpreter
# product promises. Bump both or neither.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

ARG OPENCODE_VERSION=1.18.7
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-pip \
    && bun install -g "opencode-ai@${OPENCODE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY agent-sandbox/package.json agent-sandbox/bun.lock ./
RUN bun install --frozen-lockfile
COPY agent-sandbox/src ./src

# Sessions' files and the generated opencode config live on volumes, not in the image.
# The workspace/config dirs are chowned to UID 1000 because the container drops to it at runtime.
RUN mkdir -p /workspace /config && chown -R 1000:1000 /workspace /config
ENV SANDBOX_WORKSPACE_DIR=/workspace SANDBOX_CONFIG_DIR=/config
# The proxy listens on SANDBOX_PORT (env.ts), not PORT — the variable has to name the one src reads.
ENV SANDBOX_PORT=4300
EXPOSE 4300
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=30 \
  CMD curl -fsS http://localhost:4300/health || exit 1

CMD ["bun", "src/index.ts"]
