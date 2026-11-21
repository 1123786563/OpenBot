FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build

WORKDIR /src
COPY package.json bun.lock ./
COPY tsconfig.base.json bunfig.toml ./
COPY app/package.json app/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY shared/package.json shared/package.json
COPY toolkit/package.json toolkit/package.json
COPY extension/package.json extension/package.json
RUN bun install --frozen-lockfile

COPY app app
COPY scripts scripts
COPY shared shared
COPY toolkit toolkit
COPY server server
COPY examples examples
RUN bun run --cwd app build

FROM build AS production-dependencies
RUN mkdir -p /prod/app /prod/server /prod/worker /prod/shared /prod/toolkit /prod/extension \
  && cp package.json bun.lock /prod/ \
  && for workspace in app server worker shared toolkit extension; do cp "$workspace/package.json" "/prod/$workspace/"; done \
  && cd /prod && bun install --frozen-lockfile --production

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
WORKDIR /app
COPY --from=production-dependencies /prod/ ./
COPY server server
COPY worker worker
COPY agent-computer/src/egress.ts agent-computer/src/egress.ts
COPY shared shared
COPY toolkit toolkit
COPY examples examples
COPY --from=build /src/app/dist app/dist
ENV APP_DIST_DIR=/app/app/dist
ENV NODE_ENV=production
WORKDIR /app/server
USER bun
CMD ["bun", "--no-env-file", "src/production-entry.ts"]
