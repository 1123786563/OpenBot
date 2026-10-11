#!/bin/sh
# Generated for launchd agent ai.openbot.server.
# Writes the current WorkBuddy proxy into a file launchd reads as environment
# (EnvironmentVariablesFile). The proxy port changes between WorkBuddy sessions,
# so refresh this file before (re)loading the agent.
CURRENT_HTTP="${HTTP_PROXY:-}"
CURRENT_HTTPS="${HTTPS_PROXY:-}"
TARGET="/Users/wuyongjun/trea/OpenBot/.logs/launchd-server-env.sh"

{
  echo "# refreshed $(date '+%Y-%m-%d %H:%M:%S')"
  if [ -n "$CURRENT_HTTP" ]; then
    echo "HTTP_PROXY=$CURRENT_HTTP"
    echo "http_proxy=$CURRENT_HTTP"
  fi
  if [ -n "$CURRENT_HTTPS" ]; then
    echo "HTTPS_PROXY=$CURRENT_HTTPS"
    echo "https_proxy=$CURRENT_HTTPS"
  fi
} > "$TARGET"

echo "wrote $TARGET"
cat "$TARGET"
