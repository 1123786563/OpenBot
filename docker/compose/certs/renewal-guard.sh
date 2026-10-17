#!/bin/sh
# docker/compose/certs/renewal-guard.sh — the renewal observability half of the TLS
# pipeline (#359, AC8): evaluates the wildcard certificate's state plus the last
# issue/renewal attempt, updates tls/renewal-status.json (the consumable signal for
# #362's admission gate and any dashboard), and raises alerts that are NOT silent —
# a log line always, an http(s) webhook or file append when configured
# (OPENBOT_TLS_ALERT_WEBHOOK; see docs/tls-certs.md).
#
# Two modes:
#   --once        evaluate, write status, deliver alerts. Exit 0 = ok/warn, 1 = critical.
#   --healthcheck evaluate and write status ONLY (no alert delivery — docker probes
#                 this every interval and must not burn the alert cooldown).
#                 Exit 0 = not critical, 1 = critical. This is the compose healthcheck.
#
# "starting" (no certificate and no attempt record yet — the first issuance is in
# flight, review F4) is neither critical nor alertable: exit 0, no alert, until the
# first attempt resolves the state.
#
# Alert re-fire is deduped by a cooldown (default 24h) persisted in the status file;
# a warn→critical escalation fires immediately; recovery fires exactly one "ok".

set -u
LIB_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
# shellcheck disable=SC1091
. "$LIB_DIR/lib.sh"

mode="${1:-}"
case "$mode" in
  --once | --healthcheck) ;;
  *)
    printf 'usage: renewal-guard.sh --once|--healthcheck\n' >&2
    exit 2
    ;;
esac

mkdir -p "$(tls_dir)" 2>/dev/null || true
status_file="$(tls_status_file)"
now="$(date +%s)"

days="$(cert_days_left "$(tls_cert_file)")"
attempt_ok="$(json_scalar "$status_file" lastAttemptOk)"
[ -n "$attempt_ok" ] || attempt_ok=none

decision="$(decide_health "$days" "$attempt_ok" "$(tls_warn_days)" "$(tls_crit_days)")"
severity="${decision%%|*}"
reason="${decision#*|}"

last_alert_at="$(json_scalar "$status_file" lastAlertAt)"
last_alert_severity="$(json_scalar "$status_file" lastAlertSeverity)"

# daysLeft in the status file: null when there is nothing to measure.
days_json=null
case "$days" in
  missing) : ;;
  expired) days_json=0 ;;
  *) days_json="$days" ;;
esac

if [ "$severity" = "ok" ] && [ "$reason" != "-" ]; then reason="-"; fi
status_set "$status_file" health "\"$severity\""
status_set "$status_file" healthReason "\"$reason\""
status_set "$status_file" daysLeft "$days_json"
status_set "$status_file" evaluatedAt "$now"

# "starting" is not alertable (review F4): nothing has failed yet and there is
# nothing to recover from — paging on the first issuance's normal duration would
# teach operators to ignore the channel.
if [ "$mode" = "--once" ] && [ "$severity" != "starting" ]; then
  fire="$(should_alert "$severity" "$last_alert_severity" "$last_alert_at" "$now" "$(tls_alert_cooldown_seconds)")"
  if [ "$fire" = "fire" ]; then
    alert_reason="$reason"
    [ "$severity" = "ok" ] && alert_reason=recovery
    send_alert "$severity" "$alert_reason" "$days"
    status_set "$status_file" lastAlertAt "$now"
    status_set "$status_file" lastAlertSeverity "\"$severity\""
  fi
fi

[ "$severity" = "critical" ] && exit 1
exit 0
