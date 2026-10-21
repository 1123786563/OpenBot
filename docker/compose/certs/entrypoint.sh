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
# fix-ocr5 G: private by default. The private key's 600 used to depend on
# acme.sh's internal umask — anything it writes under acme-home (the ACCOUNT
# key included) inherits whatever the image shipped. 077 makes every file and
# directory this sidecar creates owner-only; the consumers that need wider
# perms already chmod explicitly and are umask-independent: reload.sh's floor
# (key 600, cert 644) runs on every install/renewal, and this script's own
# mkdirs carry explicit chmods (TLS_DIR 750 below, ACME_HOME 700). Nothing in
# the repo reads renewal-status.json/reload.stamp as another uid — the
# compose file pins the sidecar to the same uid the preview server reads the
# key as.
umask 077
LIB_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
# shellcheck disable=SC1091
. "$LIB_DIR/lib.sh"

# fix-ocr20 #9: this script runs as PID 1 (certs.yml's entrypoint), and the
# kernel IGNORES signals a PID 1 process never registered — docker stop's
# SIGTERM did nothing and every stop was a 10s wait for SIGKILL. Registering
# TERM/INT makes both resident paths below (the skip form's sleep loop and
# the renewal loop) stop cleanly on request; the loops pair their sleep with
# `wait` so the trap fires promptly instead of after the full sleep.
trap 'exit 0' TERM INT

# fix-ocr19 #6: ACME_BIN now lives in lib.sh's exported layer (one definition,
# shared with run_renewal below and every other sourcing script) — this file
# just consumes it after sourcing.
ACME_HOME="${ACME_HOME:-/etc/openbot/tls/acme-home}"
ACME_LOG="$ACME_HOME/acme.sh.log"
TLS_DIR="$(tls_dir)"
TEMPLATE="${OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE:-}"
ACME_CA="${ACME_CA:-letsencrypt}" # letsencrypt | letsencrypt_test (staging — dry runs, no rate limits)
EMAIL="${ACME_ACCOUNT_EMAIL:-}"
DNS="${ACME_DNS:-}"
# fix-ocr19 #7: INTERVAL rides tls_numeric like every other numeric knob
# (fix-ocr18 #10's convention, now actually ours): a non-numeric value warned
# and took the DEFAULT, instead of erroring the `[ -ge ]` test into the `||`
# arm and silently renewing every 600s — the minimum cadence, 144 acme.sh runs
# a day, with nothing in any log. The 600s floor still applies beneath the
# default (a legal numeric value under it stays clamped).
INTERVAL="$(tls_numeric "${OPENBOT_TLS_RENEW_INTERVAL_SECONDS:-21600}" 21600)"
[ "$INTERVAL" -ge 600 ] || INTERVAL=600

# fix-ocr9 #3: a REFUSED start is a state, not just a log line. The two reject
# paths (template invalid, preflight failed) used to exit 1 with no status
# record at all — or only the partial previewHost/certificate fields — so the
# guard's healthcheck decided "starting" (no cert, no attempt) and a
# crash-restarting container presented a PERMANENT fake in-flight state to
# #362's admission gate and any dashboard. Writing health="failed" + the reason
# gives the guard (and every consumer) the truth; the guard preserves failed
# with failure semantics (exit 1, alertable) until a later startup gets past
# derivation and overwrites health itself (the "starting" declaration below).
# Best effort by construction: if TLS_DIR itself is not writable, the status
# write no-ops and the log line remains the durable signal.
refuse_start() {
  reason="$1"
  log "ERROR refusing to start: $reason"
  mkdir -p "$TLS_DIR" 2>/dev/null || true
  status_set "$(tls_status_file)" health '"failed"'
  status_set "$(tls_status_file)" healthReason "\"$(json_escape "$reason")\""
  status_set "$(tls_status_file)" failedAt "$(date +%s)"
  # fix-ocr21 #6: the status volume outlives compose recreations — a template
  # that flipped from valid to invalid leaves the OLD origin pair on it, and
  # the alert row / webhook below would carry a previewHost/certificate
  # nothing serves. Clear both to the empty string (the only clear status_set
  # can express — its read-modify-write preserves existing keys; the guard's
  # json_scalar reads the empty form back as unset). A start that gets past
  # derivation overwrites the pair with the fresh values right after.
  status_set "$(tls_status_file)" previewHost '""'
  status_set "$(tls_status_file)" certificate '""'
}

# ── 1. what certificate, if any ────────────────────────────────────────────────────
derivation="$(derive_preview_host "$TEMPLATE")"
case "$derivation" in
  invalid*)
    reason="${derivation#invalid|}"
    # Fail loudly and observably: restart policy retries, the healthcheck goes red,
    # and the reason is in `docker logs openbot-tls` for whoever looks — and, since
    # fix-ocr9 #3, in renewal-status.json as an explicit failed state instead of
    # nothing (which the guard rendered as a permanent "starting").
    refuse_start "$reason"
  # fix-ocr26 #10: the guard evaluates every refused start — the fix-ocr9 #3
  # refused-start alert was dead code on the refuse paths (guard --once sat
  # only on the issuance/install failure branches). It degrades gracefully
  # when TLS_DIR itself is unwritable, and the cooldown dedupes a
  # crash-looping container's repeat alerts.
  sh "$LIB_DIR/renewal-guard.sh" --once
    sleep 5
    exit 1
    ;;
  skip*)
    reason="${derivation#skip|}"
    mkdir -p "$TLS_DIR" 2>/dev/null || true
    status_set "$(tls_status_file)" health '"skipped"'
    status_set "$(tls_status_file)" healthReason "\"$(json_escape "$reason")\""
    log "no certificate pipeline: $reason"
    # fix-ocr8 #4: stay resident instead of exit 0. The compose service uses
    # `restart: on-failure` (certs.yml), which re-fires only on NON-ZERO exits
    # — and a daemon/host reboot brings back only containers that are RUNNING.
    # An exited-0 sidecar therefore stayed down for the host's lifetime: no
    # healthcheck, a frozen renewal-status.json, nothing answering for the TLS
    # pane. There is no pipeline work in the skip forms (dev/http templates
    # need no certificate), so residency is one sleep loop; the compose
    # healthcheck (renewal-guard.sh --healthcheck) keeps evaluating on its own
    # cadence, and a template change is a compose recreation, not this
    # process's business.
    while :; do
      sleep 3600 &
      wait "$!"
    done
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
# fix-ocr9 #3: this startup got past derivation — declare it. The explicit
# "starting" overwrites a stale "failed"/"skipped" left by an earlier form of
# the deployment (the volume outlives compose recreations), so the guard's
# preserve rules release and the pipeline's own truth (decided after the first
# attempt, below) takes over. The reason field is left to the guard's first
# evaluation, which rewrites the pair together.
status_set "$status_file" health '"starting"'

# ── 2. preflight ───────────────────────────────────────────────────────────────────
# Contacts are optional on the staging CA (and it forbids placeholder domains);
# production accounts get one so expiry notices reach a human.
if [ -z "$EMAIL" ] && [ "$ACME_CA" = "letsencrypt" ]; then
  # fix-ocr9 #3: every reject below records the refusal before exiting — the
  # pre-start exits used to leave the guard nothing but "starting".
  refuse_start "ACME_ACCOUNT_EMAIL is required for the production CA (expiry notices go there)"
  # fix-ocr26 #10: the guard evaluates every refused start — the fix-ocr9 #3
  # refused-start alert was dead code on the refuse paths (guard --once sat
  # only on the issuance/install failure branches). It degrades gracefully
  # when TLS_DIR itself is unwritable, and the cooldown dedupes a
  # crash-looping container's repeat alerts.
  sh "$LIB_DIR/renewal-guard.sh" --once
  sleep 5
  exit 1
fi
if [ -z "$DNS" ]; then
  refuse_start "ACME_DNS is required (the acme.sh DNS-01 plugin, e.g. dns_cf — see reference/tls-certs.md)"
  # fix-ocr26 #10: the guard evaluates every refused start — the fix-ocr9 #3
  # refused-start alert was dead code on the refuse paths (guard --once sat
  # only on the issuance/install failure branches). It degrades gracefully
  # when TLS_DIR itself is unwritable, and the cooldown dedupes a
  # crash-looping container's repeat alerts.
  sh "$LIB_DIR/renewal-guard.sh" --once
  sleep 5
  exit 1
fi
missing="$(dns_missing_credentials "$DNS")"
if [ -n "$missing" ]; then
  refuse_start "DNS-01 credentials missing for $DNS: need $missing (inject via ./dns.env — reference/tls-certs.md)"
  # fix-ocr26 #10: the guard evaluates every refused start — the fix-ocr9 #3
  # refused-start alert was dead code on the refuse paths (guard --once sat
  # only on the issuance/install failure branches). It degrades gracefully
  # when TLS_DIR itself is unwritable, and the cooldown dedupes a
  # crash-looping container's repeat alerts.
  sh "$LIB_DIR/renewal-guard.sh" --once
  sleep 5
  exit 1
fi
mkdir -p "$TLS_DIR" "$ACME_HOME" || {
  refuse_start "cannot create $TLS_DIR / $ACME_HOME (check the bind mount ownership — OPENBOT_TLS_UID/GID must match the directory's owner)"
  # fix-ocr26 #10: the guard evaluates every refused start (see above).
  sh "$LIB_DIR/renewal-guard.sh" --once
  sleep 5
  exit 1
}
if ! touch "$TLS_DIR/.writable" 2>/dev/null; then
  refuse_start "$TLS_DIR is not writable by uid $(id -u) — chown it to OPENBOT_TLS_UID or set the service user accordingly"
  # fix-ocr26 #10: the guard evaluates every refused start — the fix-ocr9 #3
  # refused-start alert was dead code on the refuse paths (guard --once sat
  # only on the issuance/install failure branches). It degrades gracefully
  # when TLS_DIR itself is unwritable, and the cooldown dedupes a
  # crash-looping container's repeat alerts.
  sh "$LIB_DIR/renewal-guard.sh" --once
  sleep 5
  exit 1
fi
chmod 750 "$TLS_DIR" 2>/dev/null || true
mkdir -p "$ACME_HOME" && chmod 700 "$ACME_HOME" 2>/dev/null || true
rm -f "$TLS_DIR/.writable"

# ── 3. first issuance ──────────────────────────────────────────────────────────────
issue() {
  # fix-ocr20 #10: the email rides the command line as ONE word. The old
  # `$account_email_args` assembly split on whitespace and expanded globs —
  # an ACME_ACCOUNT_EMAIL containing either never reached acme.sh intact.
  # POSIX sh has no arrays; `set --` appends the flag+value as two properly
  # quoted words only when the email is set.
  set -- --issue --dns "$DNS" -d "$certificate" --keylength ec-256 \
    --server "$ACME_CA"
  [ -n "$EMAIL" ] && set -- "$@" --accountemail "$EMAIL"
  out="$("$ACME_BIN" "$@" --home "$ACME_HOME" --log "$ACME_LOG" 2>&1)"
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
    --reloadcmd "sh $LIB_DIR/reload.sh" \
    --home "$ACME_HOME" --log "$ACME_LOG" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "ERROR acme.sh --install-cert exited $rc: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    # fix-ocr5 I: the failed install is an ATTEMPT, not a log line. The old
    # path only logged + exited: status kept the successful --issue's ok, no
    # guard evaluation ever ran, and #362's admission gate read FAKE health
    # through the whole outage (no cert.pem landed, so the truth is
    # critical|missing).
    record_attempt 0 issue "acme.sh --install-cert exited $rc: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ' | head -c 300)"
  fi
  return "$rc"
}

# fix-ocr8 #1: acme.sh normalizes a `*.` wildcard to `_.` in its on-disk
# domain directory (`*.preview.example.com` lives under
# "$ACME_HOME/_.preview.example.com_ecc"). The literal "${certificate}_ecc"
# directory therefore never exists, and every restart re-walked --issue — where
# the real acme.sh skips an unexpired certificate with rc 0, issue() recorded
# that skip as a SUCCESSFUL attempt (clobbering a real lastAttemptOk=false and
# firing a fake recovery — exactly what fix-ocr4 #7's record_restart fast path
# below exists to prevent) and wiped the fix-ocr5 H backoff counter.
# fix-ocr17: the normalization is wildcard_cert_dir — pure POSIX parameter
# expansion (the bash `${certificate/\*./_.}` form is a Bad-substitution crash
# under the sidecar's strict-POSIX sh), pinned by scripts/tls-pipeline.test.ts.
cert_dir="$(wildcard_cert_dir "$ACME_HOME" "$certificate")"
if [ ! -d "$cert_dir" ]; then
  log "issuing ${certificate} via ${DNS} DNS-01 (${ACME_CA})"
  if ! issue; then
    log "ERROR first issuance failed — details above and in $ACME_LOG"
    # fix-ocr17: every helper runs through sh — the exec bit is not part of
    # this pipeline's contract (the compose healthcheck invokes through sh
    # too), so a script that lost +x anywhere in the build/packaging path
    # still runs.
    sh "$LIB_DIR/renewal-guard.sh" --once
    # fix-ocr5 H: exponential backoff against the crash-restart loop, counted
    # across restarts in the counter file (schedule + rationale: lib.sh's
    # issue_backoff_seconds). A flat sleep 5 here retried LE validation
    # multiple times per hour — 5 per account per hour is the limit.
    issue_failures=$(( $(issue_failure_count) + 1 ))
    printf '%s\n' "$issue_failures" >"$(issue_backoff_file)" 2>/dev/null || true
    issue_delay="$(issue_backoff_seconds "$issue_failures")"
    log "first-issuance failure #${issue_failures}: backing off ${issue_delay}s before exit (Let's Encrypt rate-limits validation failures per account per hour)"
    sleep "$issue_delay"
    exit 1
  fi
  # Success clears the backoff slate: the next deployment problem starts at
  # the short end of the schedule, not at a stale count (fix-ocr5 H).
  rm -f "$(issue_backoff_file)" 2>/dev/null || true
else
  log "certificate already issued ($cert_dir exists)"
  # fix-ocr4 #7: a restart is NOT a successful attempt. The old
  # `record_attempt 1 issue "already issued (restart)"` clobbered a possibly-
  # failing lastAttemptOk/lastError — the guard then read a fake recovery
  # (critical→ok) and fired a false recovery alert, while the real failure
  # signal stayed silent until acme.sh's 60-day renewal window surfaced it.
  # Only timestamp-class fields move; attempt truth stands.
  record_restart
fi

if ! install_cert; then
  # fix-ocr5 I: aligned with the first-issuance failure branch above — the
  # attempt is already recorded (install_cert), the guard runs so the status
  # file carries the REAL health (#362's admission gate must not read a stale
  # ok), then the crash-restart shape retries the install (no ACME validation
  # happens on this path, so no LE backoff is needed — a flat sleep suffices).
  sh "$LIB_DIR/renewal-guard.sh" --once
  sleep 5
  exit 1
fi
sh "$LIB_DIR/renewal-guard.sh" --once

# ── 4. the renewal loop (run_renewal lives in lib.sh; the drill shares it) ────────
log "entering renewal loop (every ${INTERVAL}s; acme.sh renews at 60 days before expiry)"
while :; do
  # sleep paired with wait: the TERM/INT trap (fix-ocr20 #9) fires promptly
  # during the wait instead of after the full interval.
  sleep "$INTERVAL" &
  wait "$!"
  run_renewal || true
  sh "$LIB_DIR/renewal-guard.sh" --once || true
done
