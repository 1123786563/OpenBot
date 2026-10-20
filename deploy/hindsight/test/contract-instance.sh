#!/bin/sh
# Boot the dedicated Hindsight instance the #381 bank-isolation contract tests run against.
#
# The instance is throwaway verification infrastructure, never a deployment:
#   - image pinned to the same verified tag as deploy/hindsight/docker-compose.yml;
#   - model calls answer from the local gateway stand-in (gateway-standin.mjs), so no
#     external provider is reached; since #382 the stand-in runs with --extract-facts so
#     the retain→recall pipeline produces real hits (one echo fact per request);
#   - OpenBot's tenant/validator extensions are mounted read-only and selected, with a
#     throwaway service key and assertion secret (exported for the test run);
#   - loopback-only publish; the container is removed by `stop`.
#
# Usage: contract-instance.sh start|stop|status
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
EXTENSIONS_DIR="$REPO_ROOT/deploy/hindsight/extensions"
STANDIN_LOG="${TMPDIR:-/tmp}/hindsight-contract-gateway.log"
CONTAINER=openbot-hindsight-w4-contract
GATEWAY_PORT=9101
API_PORT=8889
# The reranker bootstraps from the HuggingFace hub, which this throwaway network never
# reaches. The verified Wave 1 container already holds the model cache; reuse it instead
# of downloading (and fail loudly if neither is available).
HF_CACHE_SOURCE=openbot-hindsight
HF_CACHE_COPY="${TMPDIR:-/tmp}/hindsight-contract-hf-cache"
export HINDSIGHT_CONTRACT_URL="http://127.0.0.1:$API_PORT"
export HINDSIGHT_CONTRACT_API_KEY="contract-test-service-key"
export HINDSIGHT_CONTRACT_ASSERTION_SECRET="contract-test-assertion-secret"

stop() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ -f "$STANDIN_LOG.pid" ]; then
    kill "$(cat "$STANDIN_LOG.pid")" >/dev/null 2>&1 || true
    rm -f "$STANDIN_LOG.pid"
  fi
}

ensure_hf_cache() {
  if [ -d "$HF_CACHE_COPY/huggingface" ]; then return 0; fi
  if ! docker exec "$HF_CACHE_SOURCE" test -d /home/hindsight/.cache/huggingface 2>/dev/null; then
    echo "no HuggingFace cache available (container $HF_CACHE_SOURCE absent or cold); the pinned reranker cannot bootstrap offline" >&2
    return 1
  fi
  rm -rf "$HF_CACHE_COPY"
  mkdir -p "$HF_CACHE_COPY"
  docker cp "$HF_CACHE_SOURCE":/home/hindsight/.cache/huggingface "$HF_CACHE_COPY"/huggingface
}

case "${1:-}" in
  stop) stop; echo "contract instance stopped"; exit 0 ;;
  status)
    docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "absent"
    exit 0 ;;
  start) ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac

stop

ensure_hf_cache

node "$REPO_ROOT/deploy/hindsight/test/gateway-standin.mjs" \
  --port "$GATEWAY_PORT" --host 0.0.0.0 --allow-non-loopback \
  --extract-facts \
  --log "$STANDIN_LOG" >/dev/null 2>&1 &
echo $! > "$STANDIN_LOG.pid"

# The stand-in needs a moment to bind before the container's boot-time connection probe.
sleep 1

# The stand-in answers fixed 8-dimension embeddings; EMBEDDINGS_OPENAI_DIMENSIONS below
# declares the same dimension so the engine's validation (and the schema it lays out)
# agrees with it instead of the model name's real 1536.
docker run -d --name "$CONTAINER" \
  --restart no \
  --shm-size 1g \
  --publish "127.0.0.1:$API_PORT:8888" \
  --env PYTHONPATH=/opt/openbot-extensions \
  --env HF_HUB_OFFLINE=1 \
  --env HINDSIGHT_API_TENANT_EXTENSION=openbot_tenant:OpenBotTenantExtension \
  --env HINDSIGHT_API_TENANT_API_KEY="$HINDSIGHT_CONTRACT_API_KEY" \
  --env HINDSIGHT_API_TENANT_ASSERTION_SECRET="$HINDSIGHT_CONTRACT_ASSERTION_SECRET" \
  --env HINDSIGHT_API_OPERATION_VALIDATOR_EXTENSION=openbot_tenant:OpenBotOperationValidator \
  --env HINDSIGHT_API_EXTENSION_PASSTHROUGH_HEADERS=x-openbot-bank-scope \
  --env HINDSIGHT_API_LLM_PROVIDER=openai \
  --env HINDSIGHT_API_LLM_BASE_URL="http://host.docker.internal:$GATEWAY_PORT/v1" \
  --env HINDSIGHT_API_LLM_API_KEY=standin \
  --env HINDSIGHT_API_LLM_MODEL=gpt-4o-mini \
  --env HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai \
  --env HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL="http://host.docker.internal:$GATEWAY_PORT/v1" \
  --env HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=standin \
  --env HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=text-embedding-3-small \
  --env HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS=8 \
  --env HINDSIGHT_API_LLM_TRACE_ENABLED=false \
  --env HINDSIGHT_API_OPERATION_RETENTION_DAYS=1 \
  --add-host host.docker.internal:host-gateway \
  --volume "$EXTENSIONS_DIR:/opt/openbot-extensions:ro" \
  --volume "$HF_CACHE_COPY/huggingface:/home/hindsight/.cache/huggingface" \
  ghcr.io/vectorize-io/hindsight:1.0.0 >/dev/null

echo "contract instance: $HINDSIGHT_CONTRACT_URL (container $CONTAINER, gateway stand-in on :$GATEWAY_PORT)"
echo "waiting for liveness"
for _ in $(seq 1 90); do
  if curl -sf -m 2 "$HINDSIGHT_CONTRACT_URL/health/live" >/dev/null 2>&1; then
    echo "liveness ok"
    exit 0
  fi
  sleep 2
done
echo "contract instance did not become live; logs:" >&2
docker logs "$CONTAINER" 2>&1 | tail -40 >&2 || true
exit 1
