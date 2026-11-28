#!/bin/sh
set -eu
umask 077
# Passwords are generated as hex so Redis configuration needs no string escaping.
case "$REDIS_PASSWORD:$REDIS_SENTINEL_PASSWORD" in
  *[!a-fA-F0-9:]*) echo 'Redis passwords must be hexadecimal' >&2; exit 1 ;;
esac
if [ "$1" = sentinel ]; then
  config=/data/sentinel.conf
  if [ ! -s "$config" ]; then
    cat > "$config" <<CONFIG
port 26379
bind 0.0.0.0
protected-mode yes
requirepass $REDIS_SENTINEL_PASSWORD
sentinel resolve-hostnames yes
sentinel announce-hostnames yes
sentinel monitor openbot-redis redis-primary 6379 2
sentinel auth-pass openbot-redis $REDIS_PASSWORD
sentinel down-after-milliseconds openbot-redis 10000
sentinel failover-timeout openbot-redis 60000
sentinel parallel-syncs openbot-redis 1
CONFIG
  fi
  exec redis-server "$config" --sentinel
fi
config=/data/redis.conf
if [ ! -s "$config" ]; then
  cat > "$config" <<CONFIG
port 6379
bind 0.0.0.0
protected-mode yes
requirepass $REDIS_PASSWORD
masterauth $REDIS_PASSWORD
appendonly yes
appendfsync everysec
maxmemory $REDIS_MAXMEMORY
maxmemory-policy noeviction
databases 16
dir /data
replica-announce-ip $REDIS_NODE_NAME
replica-announce-port 6379
CONFIG
  if [ "$1" = replica ]; then
    printf 'replicaof redis-primary 6379\n' >> "$config"
  fi
fi
# Redis and Sentinel rewrite their own configuration during failover. Preserve it on restart.
exec redis-server "$config"
