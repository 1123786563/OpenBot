# The sandbox installs opencode at the version src/version.ts pins, and the Python the interpreter
# product promises. Bump both or neither.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

ARG OPENCODE_VERSION=1.18.7
# The opencode platform packages are ~60MB binaries; a direct registry.npmjs.org download from a
# constrained network truncates them and bun reports "Fail extracting tarball". Point
# NPM_CONFIG_REGISTRY at a reachable mirror when building from one (compose wires the build arg).
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
# Bun's global bin dir defaults to /root/.bun, whose 700 perms the runtime user (UID 1000) cannot
# traverse — the /usr/local/bin/opencode shim would dangle. BUN_INSTALL=/usr/local is the same
# posture agent-computer's Dockerfile uses: the global tree lands in world-readable /usr/local.
ENV BUN_INSTALL=/usr/local
ENV PATH="/usr/local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 python3-pip \
    && bun install -g "opencode-ai@${OPENCODE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY agent-sandbox/package.json agent-sandbox/bun.lock ./
RUN bun install --frozen-lockfile
COPY agent-sandbox/src ./src
# proxy.ts imports ../../shared/execution-scope. From /app/src the ../.. walks OUT of the
# workdir to / — the module must live at /shared, not /app/shared (./shared here would leave
# the image unstartable: "Cannot find module '../../shared/execution-scope'", FT-1). This
# mirrors the repo-root bind mount shared/ → /shared:ro the FinalTest run needed before the
# fix. .dockerignore's **/node_modules keeps shared/node_modules out of the layer.
COPY shared /shared

# Sessions' files and the generated opencode config live on volumes, not in the image.
# The workspace/config dirs are chowned to UID 1000 because the container drops to it at runtime.
RUN mkdir -p /workspace /config && chown -R 1000:1000 /workspace /config
# BUN_INSTALL=/usr/local (above) is a build-time posture, but bun's installer reads it at
# runtime too: `bun install` inside a session derives its cache/tempdir from it, and
# /usr/local is root-owned — every install answered AccessDenied (craft's webapp scaffold
# died on its first bun install). Pin the cache under the runtime user's home, owned by it,
# unless the deployment overrides.
ENV BUN_INSTALL_CACHE_DIR=/home/bun/.bun/install-cache
RUN mkdir -p /home/bun/.bun/install-cache && chown -R 1000:1000 /home/bun/.bun
ENV SANDBOX_WORKSPACE_DIR=/workspace SANDBOX_CONFIG_DIR=/config
# The proxy listens on SANDBOX_PORT (env.ts), not PORT — the variable has to name the one src reads.
ENV SANDBOX_PORT=4300
EXPOSE 4300
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=30 \
  CMD curl -fsS http://localhost:4300/health || exit 1

CMD ["bun", "src/index.ts"]
