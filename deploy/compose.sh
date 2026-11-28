#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: deploy/compose.sh [--local|--central] <component> <docker compose args...>' \
    'Components: postgres bifrost infisical openobserve hindsight opik agents openbot' \
    'Local-only component: spire' \
    'Central components: infrastructure bifrost infisical openobserve hindsight opik spire agents flexprice openbot' \
    'Central environment: CENTRAL_ENV_FILE (default deploy/centralized/.env)'
}

if [[ ${1:-} == --help || $# == 0 ]]; then
  usage
  exit 0
fi

deploy=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $1 == --central ]]; then
  shift
  if (( $# < 2 )); then
    usage >&2
    exit 2
  fi
  component=$1
  shift
  central="$deploy/centralized"
  central_env=${CENTRAL_ENV_FILE:-$central/.env}
  case "$component" in
    infrastructure)
      args=(--project-directory "$central" -f "$central/docker-compose.yml")
      ;;
    bifrost|openobserve|openbot)
      args=(--project-directory "$deploy/$component" -f "$deploy/$component/docker-compose.yml"
        -f "$central/apps/$component.yml")
      ;;
    infisical|hindsight|opik|spire|agents|flexprice)
      args=(--project-directory "$central" -f "$central/apps/$component.yml")
      ;;
    *)
      printf 'Unknown central component: %s\n' "$component" >&2
      usage >&2
      exit 2
      ;;
  esac
  exec docker compose --env-file "$central_env" "${args[@]}" "$@"
fi
local_mode=false
if [[ $1 == --local ]]; then
  local_mode=true
  shift
fi
if (( $# < 2 )); then
  usage >&2
  exit 2
fi
component=$1
shift
local_config="$deploy/.local"

case "$component" in
  postgres|bifrost|infisical|openobserve|hindsight|opik|agents|openbot)
    directory="$deploy/$component"
    ;;
  spire)
    if [[ $local_mode != true ]]; then
      usage >&2
      exit 2
    fi
    exec docker compose --env-file "$local_config/agents.env" --env-file "$local_config/spire.env" \
      -p openbot-local-spire -f "$deploy/../docker-compose.yml" "$@"
    ;;
  *)
    printf 'Unknown component: %s\n' "$component" >&2
    usage >&2
    exit 2
    ;;
esac

args=(-f "$directory/docker-compose.yml")
if [[ $local_mode == true && $component != infisical ]]; then
  args+=(--env-file "$local_config/$component.env")
  case "$component" in
    bifrost) args+=(-f "$directory/docker-compose.override.yml.example" -f "$local_config/bifrost.yml") ;;
    agents|openbot) args+=(-f "$local_config/$component.yml") ;;
    opik) export OPIK_SOURCE="$local_config/upstream-opik" ;;
  esac
else
  args+=(--env-file "$directory/.env")
  if [[ -f "$directory/docker-compose.override.yml" ]]; then
    args+=(-f "$directory/docker-compose.override.yml")
  fi
fi
exec docker compose "${args[@]}" "$@"
