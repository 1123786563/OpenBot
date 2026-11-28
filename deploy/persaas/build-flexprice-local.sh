#!/usr/bin/env bash
set -euo pipefail
out=${1:?Usage: build-flexprice-local.sh /absolute/output-directory [backend-source] [frontend-source]}
backend=${2:-/Users/wuyj/IdeaProjects/flexprice}
frontend=${3:-/Users/wuyj/IdeaProjects/flexprice-front}
case "$out" in /*) ;; *) echo 'Output must be an absolute path' >&2; exit 2 ;; esac
mkdir -p "$out/backend" "$out/frontend/dist"
revision=$(git -C "$backend" rev-parse HEAD)
cd "$backend"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags="-s -w -X github.com/flexprice/flexprice/internal/buildinfo.Version=persaas-local -X github.com/flexprice/flexprice/internal/buildinfo.GitSHA=$revision" \
  -o "$out/backend/server" ./cmd/server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$out/backend/migrate" ./cmd/migrate
cp -R internal/config migrations assets "$out/backend/"
cat > "$out/backend/Dockerfile" <<'DOCKER'
FROM flexprice:2.1.52-persaas
USER root
COPY --chown=app:app server migrate /app/
COPY --chown=app:app config /app/config
COPY --chown=app:app migrations /app/migrations
COPY --chown=app:app assets /app/assets
USER app
DOCKER
cd "$frontend"
npm ci --no-audit --no-fund
VITE_API_URL=/v1 VITE_APP_ENV=self-hosted VITE_AUTH_ENABLED=true \
  VITE_AUTH_PROVIDER=flexprice VITE_POSTHOG_ENABLED=false \
  VITE_INTERCOM_ENABLED=false VITE_PADDLE_ENABLED=false npm run build
cp -R dist/. "$out/frontend/dist/"
cat > "$out/frontend/Dockerfile" <<'DOCKER'
FROM nginx:1.28-alpine
COPY dist /usr/share/nginx/html
DOCKER
# Only compiled artifacts/default configuration are packaged; no repository .env files.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out/release.tar.gz" -C "$out" backend frontend
printf 'Built local-source release: %s\n' "$out/release.tar.gz"
