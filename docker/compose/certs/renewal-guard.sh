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
# TODO(consumer, fix-ocr18 #13): #362's server-side admission gate is the named
# reader of tls/renewal-status.json and does not exist yet. Until it lands, the
# file's schema is pinned by enumeration in scripts/tls-pipeline.test.ts
# ("renewal-status.json key roster") — a field added or removed must update that
# roster, which is the moment to re-home it beside the consumer.
#
# Fields with NO consumer at all today (fix-ocr20 #7): lastReloadOk/lastReloadAt
# (reload.sh's hook outcome — the guard deliberately does not alert on them;
# a broken live-reload is visible only to a direct reader of the file). The
# #362 batch above is where their alerting/admission semantics get decided.
#
# "starting" (no certificate and no attempt record yet — the first issuance is in
# flight, review F4) is neither critical nor alertable: exit 0, no alert, until
# the first attempt resolves the state. fix-ocr9 #3: a REJECTED startup no
# longer presents as starting — the entrypoint records health="failed" (+ the
# reason) before exiting, and the guard preserves it with failure semantics
# (exit 1; alertable on --once) instead of re-deciding it away.
# fix-ocr9 #2: the skip form's health is the entrypoint's answer, not the
# certificate's — health="skipped" (no-pipeline forms: the dev template, a
# localhost base) is
# preserved verbatim while the ENVIRONMENT is still the skip form (a template
# flip re-decides), instead of being overwritten to an eternal "starting".
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

# fix-ocr22 #5: --once's run is ONE critical section — read lastAlert* →
# judge → RESERVE the alert position (write lastAlert*) → emit the durable
# alert_log line → release → deliver the webhook (fix-ocr26 #11 moved the
# network half OUT of the section: a -m 15 curl inside the mutex outlasted
# the 5s spin budget and let a concurrent guard degrade past the held lock,
# read the pre-alert cooldown state, and double-page). Unlocked, two
# concurrent guards (a
# cron'd --once racing the entrypoint's post-failure guard call) both read
# the pre-alert cooldown state, both pass should_alert, and both page — the
# double-fire the cooldown exists to prevent. The SAME mkdir lock status_set
# uses is held from BEFORE those reads to after the last write; every
# status_set inside this script then rides the holder's lock (owner == $$)
# instead of deadlock-spinning on it. --healthcheck never alerts, so it keeps
# the per-write locking only — a docker probe must not queue behind a 15s
# webhook timeout.
guard_lock_held=""
if [ "$mode" = "--once" ]; then
  status_lock_acquire "$status_file" && guard_lock_held=1
fi
release_guard_lock() {
  if [ -n "$guard_lock_held" ]; then
    status_lock_release "$status_file"
  fi
}

now="$(date +%s)"

stored_health="$(json_scalar "$status_file" health)"
last_alert_at="$(json_scalar "$status_file" lastAlertAt)"
last_alert_severity="$(json_scalar "$status_file" lastAlertSeverity)"

# fix-ocr9 #2: the skip form's health belongs to the ENTRYPOINT. The skip
# branch (dev/empty template, or a localhost base — and until fix-ocr18 #9,
# http templates, which are invalid now) wrote health="skipped" and stays
# resident (fix-ocr8 #4); the healthcheck's certificate-based decision (no
# cert, no attempt) re-labeled that "starting" on its first cycle — forever,
# since neither will ever exist for this form. The preserve is keyed on the
# CURRENT environment (derive the template env, exactly what the entrypoint
# branched on): a compose recreation that flips the template to a valid form
# releases the preserve and the guard decides fresh again ("starting" until
# the first attempt resolves) — preserving unconditionally would just move
# the eternal-stale disease to the opposite transition.
# Everything except evaluatedAt is left untouched; evaluatedAt keeps the
# guard's liveness trace without touching the skip semantics.
derivation="$(derive_preview_host "${OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:-}")"
case "$derivation" in
  skip*)
    if [ "$stored_health" = "skipped" ]; then
      status_set "$status_file" evaluatedAt "$now"
      release_guard_lock
      exit 0
    fi
    ;;
esac

# fix-ocr9 #3: a refused start is a DECIDED state — the entrypoint could not
# even begin pipeline work, and the certificate-based decision below would
# read that as "starting" (fake in-flight, permanent). Preserve the explicit
# failure and give it failure semantics: exit 1 in BOTH modes (critical-class:
# the pipeline is not running), alertable on --once with reason refused-start
# (severity critical — the honest severity for a sidecar that never started).
# should_alert's cooldown dedupes re-fires, and a later recovery to ok still
# fires exactly one recovery alert, because the transition bookkeeping is the
# same lastAlert* machinery the critical path uses.
if [ "$stored_health" = "failed" ]; then
  days="$(cert_days_left "$(tls_cert_file)")"
  if [ "$mode" = "--once" ]; then
    fire="$(should_alert critical "$last_alert_severity" "$last_alert_at" "$now" "$(tls_alert_cooldown_seconds)")"
    if [ "$fire" = "fire" ]; then
      # fix-ocr26 #11: the alert position is RESERVED INSIDE the critical
      # section (the cooldown state moves while the mutex still holds), the
      # durable log line is emitted (cheap, no network), and evaluatedAt is
      # refreshed (fix-ocr22 #6) — then the lock is released and only the
      # webhook delivery runs OUTSIDE it: a -m 15 curl inside the mutex
      # outlasted the 5s spin budget and let a concurrent guard read the
      # pre-alert state and double-page.
      status_set "$status_file" lastAlertAt "$now"
      status_set "$status_file" lastAlertSeverity '"critical"'
      status_set "$status_file" evaluatedAt "$now"
      alert_log critical refused-start "$days"
      release_guard_lock
      guard_lock_held=""
      alert_webhook critical refused-start "$days"
      exit 1
    fi
  fi
  # fix-ocr22 #6: crash-loop 期时间戳停滞无法区分「故障持续（guard 仍在评估）」
  # 与「文件冻结（guard 死了）」— exit 前刷 evaluatedAt，与 skip 保留分支同一
  # 形态；两种模式一致（healthcheck 的 60s 探测是失败期唯一必然的心跳）。
  status_set "$status_file" evaluatedAt "$now"
  release_guard_lock
  exit 1
fi

days="$(cert_days_left "$(tls_cert_file)")"
attempt_ok="$(json_scalar "$status_file" lastAttemptOk)"
[ -n "$attempt_ok" ] || attempt_ok=none

decision="$(decide_health "$days" "$attempt_ok" "$(tls_warn_days)" "$(tls_crit_days)")"
severity="${decision%%|*}"
reason="${decision#*|}"

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
    # fix-ocr26 #11: reserve the alert position and emit the durable log line
    # INSIDE the critical section — every status_set here rides the holder's
    # lock — then release and deliver the webhook OUTSIDE it. The lock is
    # never held across network I/O again.
    status_set "$status_file" lastAlertAt "$now"
    status_set "$status_file" lastAlertSeverity "\"$severity\""
    alert_log "$severity" "$alert_reason" "$days"
    release_guard_lock
    guard_lock_held=""
    alert_webhook "$severity" "$alert_reason" "$days"
  fi
fi

release_guard_lock
[ "$severity" = "critical" ] && exit 1
exit 0
