#!/bin/bash
# MT013 fix round boot-slice runner — cw (corrupt waivers) and mw (missing waivers).
# Both must end: exit 1 + exactly one structured record + no stack on stderr.
cd /Users/wuyongjun/orca/workspaces/OpenBot/i6-mt013 || exit 99

# loadConfig-satisfying base env (same shape as the review round's boot-base.env)
export DATABASE_URL='postgres://nobody@127.0.0.1:1/none'
export KEY_ENCRYPTION_KEY='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
export GOOGLE_OAUTH_CLIENT_ID='google-client-id'
export GOOGLE_OAUTH_CLIENT_SECRET='google-client-secret'
export BETTER_AUTH_SECRET='a-long-enough-local-development-auth-secret'
export BETTER_AUTH_URL='http://localhost:3001'
export INITIAL_ADMIN_EMAILS='admin@openbot.test'
export INTELLIGENCE_API_URL='http://localhost:7100'
export INTELLIGENCE_GATEWAY_WS_URL='ws://localhost:7103'
export INTELLIGENCE_API_KEY='tenant-api-key'
export COPILOTKIT_LICENSE_TOKEN='license-token'
export MANAGED_AGENT_AG_UI_URL='http://localhost:4200/ag-ui'
export MANAGED_AGENT_TOKEN='managed-agent-token'

export OPENBOT_MULTITENANCY='on'
export OPENBOT_MULTITENANCY_INVENTORY='/tmp/mt013fix/inventory-owned.json'
# real restricted-role connections so databaseRoles is exercised and passes
source /tmp/mt013fix/env.sh
export ENTERPRISE_DIRECTORY_DATABASE_URL="$ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"
export ENTERPRISE_DATA_DATABASE_URL="$ENTERPRISE_TEST_DATA_DATABASE_URL"
export OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL="$ENTERPRISE_TEST_OPERATOR_DATABASE_URL"

case "$1" in
  cw)
    export OPENBOT_MULTITENANCY_WAIVERS='/tmp/mt013fix/waivers-corrupt.json'
    ;;
  mw)
    export OPENBOT_MULTITENANCY_WAIVERS='/tmp/mt013fix/waivers-missing.json'
    ;;
  ok)
    # positive control: valid waivers file that exists → coverage passes, exit 0
    export OPENBOT_MULTITENANCY_WAIVERS='/tmp/mt013fix/waivers-valid.json'
    ;;
  *)
    echo "usage: $0 cw|mw|ok" >&2; exit 99;;
esac

bun --no-env-file /tmp/mt013fix/boot-slice.ts
