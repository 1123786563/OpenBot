#!/bin/sh
# docker/compose/certs/entrypoint.sh — the issuance + renewal loop of the TLS
# sidecar (#359, AC8). Replaces the acme.sh image's own daemon/cron so the pipeline
# owns failure detection: acme.sh only tells cron's stderr when a renewal fails,
# which nobody reads — here every cycle records the attempt outcome into
# tls/renewal-status.json and hands it to renewal-guard.sh for alerting.
#
# Flow:
#   1. derive the wildcard base from OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE
#      (skip with an explanation for the dev/empty/http forms — never an error),
#   2. validate DNS provider credentials (names only, values never logged),
#   3. issue *.<base> once via ACME DNS-01 (Let's Encrypt; ACME_CA picks staging),
#   4. --install-cert into /etc/openbot/tls with reload.sh as the reloadcmd —
#      acme.sh re-runs it on every successful renewal, so a new certificate takes
#      effect without anyone touching the server (a reload hook, NOT a restart:
#      in-flight connections and websocket upgrades survive),
#   5. loop: `acme.sh --cron` every OPENBOT_TLS_RENEW_INTERVAL_SECONDS (acme.sh
#      itself renews certificates 60 days before expiry, well ahead of the 90-day
#      deadline), then renewal-guard.sh --once.
#
# OPENBOT_TLS_RENEW_CMD overrides the renewal command (the failure drill's seam).

set -u
LIB_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
# shellcheck disable=SC1091
. "$LIB_DIR/lib.sh"

ACME_BIN="${ACME_BIN:-acme.sh}"
ACME_HOME="${ACME_HOME:-/etc/openbot/tls/acme-home}"
ACME_LOG="$ACME_HOME/acme.sh.log"
TLS_DIR="$(tls_dir)"
TEMPLATE="${OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:-}"
ACME_CA="${ACME_CA:-letsencrypt}" # letsencrypt | letsencrypt_test (staging — dry runs, no rate limits)
EMAIL="${ACME_ACCOUNT_EMAIL:-}"
DNS="${ACME_DNS:-}"
INTERVAL="${OPENBOT_TLS_RENEW_INTERVAL_SECONDS:-21600}"
[ "$INTERVAL" -ge 600 ] || INTERVAL=600

# ── 1. what certificate, if any ────────────────────────────────────────────────────
derivation="$(derive_preview_host "$TEMPLATE")"
case "$derivation" in
  invalid*)
    reason="${derivation#invalid|}"
    log "ERROR refusing to start: $reason"
    # Fail loudly and observably: restart policy retries, the healthcheck goes red,
    # and the reason is in `docker logs openbot-tls` for whoever looks.
    sleep 5
    exit 1
    ;;
  skip*)
    reason="${derivation#skip|}"
    mkdir -p "$TLS_DIR" 2>/dev/null || true
    status_set "$(tls_status_file)" health '"skipped"'
    status_set "$(tls_status_file)" healthReason "\"$(json_escape "$reason")\""
    log "no certificate pipeline: $reason"
    # Exit 0: with nothing to do, the container stays down quietly (no crash loop,
    # no red healthcheck) — the dev form is a valid deployment, not a failure.
    exit 0
    ;;
esac
scheme="$(printf '%s' "$derivation" | cut -d'|' -f2)"
base="$(printf '%s' "$derivation" | cut -d'|' -f3)"
certificate="*.${base}"
log "pipeline target: ${certificate} (preview base ${base}, from ${scheme} template)"

status_file="$(tls_status_file)"
status_set "$status_file" previewHost "\"$base\""
status_set "$status_file" certificate "\"$certificate\""
status_set "$status_file" ca "\"$ACME_CA\""

# ── 2. preflight ───────────────────────────────────────────────────────────────────
# Contacts are optional on the staging CA (and it forbids placeholder domains);
# production accounts get one so expiry notices reach a human.
if [ -z "$EMAIL" ] && [ "$ACME_CA" = "letsencrypt" ]; then
  log "ERROR ACME_ACCOUNT_EMAIL is required for the production CA (expiry notices go there)"
  sleep 5
  exit 1
fi
if [ -z "$DNS" ]; then
  log "ERROR ACME_DNS is required (the acme.sh DNS-01 plugin, e.g. dns_cf — see docs/tls-certs.md)"
  sleep 5
  exit 1
fi
missing="$(dns_missing_credentials "$DNS")"
if [ -n "$missing" ]; then
  log "ERROR DNS-01 credentials missing for $DNS: need $missing (inject via ./dns.env — docs/tls-certs.md)"
  sleep 5
  exit 1
fi
mkdir -p "$TLS_DIR" "$ACME_HOME" || {
  log "ERROR cannot create $TLS_DIR / $ACME_HOME (check the bind mount ownership — OPENBOT_TLS_UID/GID must match the directory's owner)"
  sleep 5
  exit 1
}
if ! touch "$TLS_DIR/.writable" 2>/dev/null; then
  log "ERROR $TLS_DIR is not writable by uid $(id -u) — chown it to OPENBOT_TLS_UID or set the service user accordingly"
  sleep 5
  exit 1
fi
chmod 750 "$TLS_DIR" 2>/dev/null || true
mkdir -p "$ACME_HOME" && chmod 700 "$ACME_HOME" 2>/dev/null || true
rm -f "$TLS_DIR/.writable"

# ── 3. first issuance ──────────────────────────────────────────────────────────────
issue() {
  account_email_args=""
  [ -n "$EMAIL" ] && account_email_args="--accountemail $EMAIL"
  # shellcheck disable=SC2086 # account_email_args is either empty or one flag+value
  out="$("$ACME_BIN" --issue --dns "$DNS" -d "$certificate" --keylength ec-256 \
    --server "$ACME_CA" $account_email_args --home "$ACME_HOME" --log "$ACME_LOG" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    record_attempt 0 issue "acme.sh --issue exited $rc: $(printf '%s' "$out" | tail -n 5 | tr '\n' ' ' | head -c 300)"
    return "$rc"
  fi
  record_attempt 1 issue ""
  return 0
}

install_cert() {
  # --install-cert registers the file destinations AND reloadcmd in the domain
  # config; acme.sh replays it on every successful renewal from --cron.
  out="$("$ACME_BIN" --install-cert -d "$certificate" --ecc \
    --fullchain-file "$TLS_DIR/cert.pem" \
    --key-file "$TLS_DIR/key.pem" \
    --reloadcmd "$LIB_DIR/reload.sh" \
    --home "$ACME_HOME" --log "$ACME_LOG" 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] && log "ERROR acme.sh --install-cert exited $rc: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
  return "$rc"
}

if [ ! -d "$ACME_HOME/${certificate}_ecc" ]; then
  log "issuing ${certificate} via ${DNS} DNS-01 (${ACME_CA})"
  if ! issue; then
    log "ERROR first issuance failed — details above and in $ACME_LOG"
    "$LIB_DIR/renewal-guard.sh" --once
    sleep 5
    exit 1
  fi
else
  log "certificate already issued (${ACME_HOME}/${certificate}_ecc exists)"
  record_attempt 1 issue "already issued (restart)"
fi

if ! install_cert; then
  sleep 5
  exit 1
fi
"$LIB_DIR/renewal-guard.sh" --once

# ── 4. the renewal loop (run_renewal lives in lib.sh; the drill shares it) ────────
log "entering renewal loop (every ${INTERVAL}s; acme.sh renews at 60 days before expiry)"
while :; do
  sleep "$INTERVAL"
  run_renewal || true
  "$LIB_DIR/renewal-guard.sh" --once || true
done
