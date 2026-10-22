#!/bin/sh
# docker/compose/preview-tls/reload-watcher.sh — the reload.stamp CONSUMER (#412,
# AC2 seam made runnable). docker/compose/certs/reload.sh bumps the mtime of
# tls/reload.stamp after every certificate install/renewal; this script polls that
# mtime inside the terminator container and turns a bump into `nginx -s reload` —
# a SIGHUP: the listener, in-flight requests and websocket upgrades survive, and the
# next TLS accept already uses the new certificate. A reload, never a restart.
#
# Relation to OPENBOT_TLS_RELOAD_URL (docs/tls-certs.md, reload hooks): they are
# ALTERNATIVES — pick exactly one.
#   - This watcher: the terminator watches the shared TLS directory. Works for
#     nginx-style signal-reloaded proxies with no HTTP reload endpoint.
#   - OPENBOT_TLS_RELOAD_URL: the sidecar POSTs to the terminator's own reload
#     endpoint (Traefik/Caddy admin APIs, a managed balancer). For this reference
#     topology nginx has no such endpoint, so leave it UNSET when running this
#     watcher — otherwise the sidecar logs a harmless WARN per renewal.
#
# Strict POSIX sh: the nginx:alpine image has no bash.

set -u

STAMP="/etc/openbot/tls/reload.stamp"
POLL_SECONDS="${OPENBOT_PREVIEW_TLS_RELOAD_POLL_SECONDS:-15}"
# LOW-6: a non-positive value (empty/0/non-numeric) would spin a tight loop or
# error-storm sleep; fall back to the default 15.
case "$POLL_SECONDS" in
  ''|*[!0-9]*) POLL_SECONDS=15 ;;
  0) POLL_SECONDS=15 ;;
esac
# An absurdly large value would pass the digits-only test but overflow `sleep`
# (usage error, instant exit) — effectively a tight loop. Cap it: anything past
# 86400 (a day) is beyond any sane poll cadence, take the default instead.
# Length is checked first so shell arithmetic never sees an oversized literal.
if [ "${#POLL_SECONDS}" -gt 5 ] || [ "$POLL_SECONDS" -gt 86400 ]; then
  POLL_SECONDS=15
fi

log() {
  # Match the sidecar's log prefix convention (openbot-tls vs its consumer) so a
  # single Loki/tail query on "openbot-tls" finds both sides of the handoff.
  echo "[openbot-preview-tls] $*"
}

last="uninitialized"

log "watching $STAMP every ${POLL_SECONDS}s (reload.stamp mtime -> nginx -s reload)"

while :; do
  # busybox stat: seconds-precision mtime is enough — the sidecar's `touch` can
  # never land twice inside one second for distinct renewals that matter.
  cur="$(stat -c %Y "$STAMP" 2>/dev/null || echo missing)"

  if [ "$cur" != "$last" ]; then
    if [ "$cur" = "missing" ]; then
      # Before the first issuance there is no stamp (and no cert.pem either — nginx
      # cannot even start). Say it once per state change and keep polling.
      log "reload.stamp not present yet — waiting for the first issuance"
      last="$cur"
    elif [ "$last" = "uninitialized" ]; then
      # First sighting after this container's own start: nginx already loaded the
      # current files, nothing to reload. Just record the baseline.
      log "baseline reload.stamp mtime $cur recorded"
      last="$cur"
    else
      log "reload.stamp mtime $last -> $cur; reloading nginx"
      # LOW-8: keep nginx -t / nginx -s reload stderr in the WARN logs — the
      # cause (half-written cert pair, config error) is the diagnostic; stdout
      # carries nothing of value here.
      if nginx -t 2>/tmp/reload-nginx-t.err && nginx -s reload 2>/tmp/reload-nginx.err; then
        # nginx -t guards a half-written cert/key pair: a failed reload leaves the
        # OLD certificate serving (the AC "old cert keeps serving" behavior) instead
        # of taking the listener down on a bad file.
        log "nginx reloaded; next TLS accept uses the new certificate"
        # F3 (OCR R1): consume the bump ONLY on success. On failure `last` stays
        # put, so the very next loop iteration sees the same mtime and retries;
        # the loop's own sleep is the retry backoff (once per POLL_SECONDS), so
        # no tight retry storm.
        last="$cur"
      else
        log "WARN reload failed (nginx -t/reload nonzero) — old certificate still serving; will retry this bump next poll"
        [ -s /tmp/reload-nginx-t.err ] && log "WARN nginx -t stderr: $(cat /tmp/reload-nginx-t.err)"
        [ -s /tmp/reload-nginx.err ] && log "WARN nginx -s reload stderr: $(cat /tmp/reload-nginx.err)"
      fi
      rm -f /tmp/reload-nginx-t.err /tmp/reload-nginx.err
    fi
  fi

  sleep "$POLL_SECONDS"
done
