#!/bin/sh
# docker/compose/certs/drill-renewal-failure.sh — the AC8 failure drill (#359):
# inject ONE renewal failure and prove the two claims the acceptance criteria name:
#   (a) the failure is OBSERVED — an alert fires (severity critical, reason
#       renewal-failed) through the configured channel, not silence,
#   (b) the SERVICE IS UNAFFECTED while the old certificate is valid — the
#       installed cert.pem/key.pem are byte-for-byte untouched (sha256).
#
# Two modes:
#   --offline (default)  Deterministic, no network, no docker: fabricates a valid
#                        90-day certificate, drives the REAL run_renewal seam
#                        (OPENBOT_TLS_RENEW_CMD="exit 70") and the REAL
#                        renewal-guard.sh, and asserts on their artifacts. This is
#                        what CI runs (scripts/tls-pipeline.test.ts).
#   --live-staging       The true path: docker compose runs the sidecar against
#                        Let's Encrypt STAGING with deliberately INVALID DNS
#                        credentials (ACME_CA=letsencrypt_test, CF_Token=…-drill).
#                        The DNS-01 challenge fails at the provider API — the
#                        same code path a revoked token hits in production. Asserts
#                        the failure is recorded + alerted and no certificate was
#                        installed. Needs docker + outbound network.
#
# Usage: sh docker/compose/certs/drill-renewal-failure.sh [--offline|--live-staging]
#        (fix-ocr22 #10: `sh`, matching the shebang — the drill is strict
#        POSIX and never needed bash)
#        KEEP=1 keeps the scratch directory (default: removed on success).

set -u
CERTS_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$CERTS_DIR/lib.sh"
GUARD="$CERTS_DIR/renewal-guard.sh"
# shellcheck source=lib.sh
# shellcheck disable=SC1091
. "$LIB"

mode="${1:---offline}"

PASS_COUNT=0
pass() { printf 'PASS %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
assert_eq() { # label expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected [$2], got [$3])"; fi
}

drill_offline() {
  work="$(mktemp -d "${TMPDIR:-/tmp}/openbot-tls-drill.XXXXXX")"
  printf 'offline drill workspace: %s\n' "$work"

  # ── the "old certificate": valid for 90 days, already installed ────────────────
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$work/key.pem" -out "$work/cert.pem" -days 90 -subj '/CN=*.drill.invalid' >/dev/null 2>&1 \
    || fail "openssl could not fabricate the old certificate"
  chmod 600 "$work/key.pem"

  cert_before="$(sha_of "$work/cert.pem")"
  key_before="$(sha_of "$work/key.pem")"

  export OPENBOT_TLS_DIR="$work"
  status_set "$(tls_status_file)" previewHost '"drill.invalid"'
  status_set "$(tls_status_file)" certificate '"*.drill.invalid"'

  webhook="file:$work/alerts.jsonl"

  # Baseline: healthy, silent.
  OPENBOT_TLS_ALERT_WEBHOOK="$webhook" sh "$GUARD" --once >/dev/null 2>&1 \
    || fail "baseline guard should be healthy (90-day cert, no attempt recorded)"
  pass "baseline: healthy certificate, no alert"

  # ── inject ONE renewal failure through the real seam ───────────────────────────
  OPENBOT_TLS_RENEW_CMD="exit 70" sh "$LIB" __run-renewal >/dev/null 2>&1
  assert_eq "failed attempt recorded (lastAttemptOk)" "false" \
    "$(json_scalar "$(tls_status_file)" lastAttemptOk)"

  # (a) the failure alerts.
  OPENBOT_TLS_ALERT_WEBHOOK="$webhook" sh "$GUARD" --once >/dev/null 2>&1
  guard_rc=$?
  [ "$guard_rc" -eq 1 ] || fail "guard should exit critical after a failed renewal (got $guard_rc)"
  pass "guard: critical exit after failed renewal"
  alerts="$(cat "$work/alerts.jsonl" 2>/dev/null || printf '')"
  printf '%s' "$alerts" | grep -q '"severity":"critical"' || fail "no critical alert was delivered"
  printf '%s' "$alerts" | grep -q '"reason":"renewal-failed"' || fail "alert reason is not renewal-failed"
  pass "alert delivered: severity=critical reason=renewal-failed"

  # (b) the service is unaffected while the old certificate is valid.
  assert_eq "old cert.pem untouched (sha256)" "$cert_before" "$(sha_of "$work/cert.pem")"
  assert_eq "old key.pem untouched (sha256)" "$key_before" "$(sha_of "$work/key.pem")"
  assert_eq "key.pem still 600" "600" "$(stat -c '%a' "$work/key.pem" 2>/dev/null || stat -f '%Lp' "$work/key.pem")"

  # Cooldown: the same failure does not re-page immediately…
  OPENBOT_TLS_ALERT_WEBHOOK="$webhook" sh "$GUARD" --once >/dev/null 2>&1
  [ "$(wc -l <"$work/alerts.jsonl" | tr -d ' ')" -eq 1 ] || fail "cooldown did not suppress the repeat alert"
  pass "cooldown: repeat failure does not re-alert"
  # …but a zero cooldown does re-alert, so a persistently broken renewal keeps paging.
  OPENBOT_TLS_ALERT_COOLDOWN_SECONDS=0 OPENBOT_TLS_ALERT_WEBHOOK="$webhook" sh "$GUARD" --once >/dev/null 2>&1
  [ "$(wc -l <"$work/alerts.jsonl" | tr -d ' ')" -eq 2 ] || fail "zero cooldown should re-alert"
  pass "cooldown expiry: persistent failure re-alerts"

  # ── recovery: a renewal succeeds again (new certificate installed) ───────────
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$work/key.new" -out "$work/cert.new" -days 90 -subj '/CN=*.drill.invalid' >/dev/null 2>&1
  OPENBOT_TLS_RENEW_CMD="cp '$work/cert.new' '$work/cert.pem' && exit 0" sh "$LIB" __run-renewal >/dev/null 2>&1 \
    || fail "successful renewal run should exit 0"
  assert_eq "successful attempt recorded (lastAttemptOk)" "true" \
    "$(json_scalar "$(tls_status_file)" lastAttemptOk)"
  OPENBOT_TLS_ALERT_COOLDOWN_SECONDS=86400 OPENBOT_TLS_ALERT_WEBHOOK="$webhook" sh "$GUARD" --once >/dev/null 2>&1 \
    || fail "guard should return to health after a successful renewal"
  tail -n 1 "$work/alerts.jsonl" | grep -q '"severity":"ok"' || fail "no recovery alert"
  pass "recovery: health restored, single ok alert"

  if [ "${KEEP:-0}" != "1" ]; then rm -rf "$work"; fi
  printf 'offline drill: %d assertions passed\n' "$PASS_COUNT"
}

drill_live_staging() {
  command -v docker >/dev/null 2>&1 || fail "--live-staging needs docker"
  # fix-ocr18 #12: the bounded run below shells out to timeout(1). On a host
  # without it the spawn exits 127 BEFORE docker runs — and 127 is ≠0, exactly
  # what the failure path expects, so the drill reported a fake PASS that
  # never touched the cluster. Fail loud in the preflight instead, beside the
  # docker check.
  command -v timeout >/dev/null 2>&1 || fail "--live-staging needs timeout(1)"
  # fix-ocr17: resolve the compose file against the REPO ROOT, not the
  # caller's cwd — `--project-directory .` with a relative -f resolved
  # against wherever the drill happened to run from, so an invocation from
  # any other directory made compose fail with rc≠0 and the drill reported a
  # fake PASS. (The relative tls/ mount default inside certs.yml keeps
  # resolving against --project-directory, unchanged.)
  repo_root="$(cd "$CERTS_DIR/../.." && pwd)"
  work="$(mktemp -d "${TMPDIR:-/tmp}/openbot-tls-drill-live.XXXXXX")"
  printf 'live-staging drill workspace: %s\n' "$work"

  # A template on a domain we do not own is fine for the FAILURE path — but it
  # must be one the CA will accept in a new-order (reserved TLDs like .invalid are
  # rejected before any challenge): a syntactically valid, clearly-drill domain.
  # The order is created, then DNS-01 dies at the provider API (invalid token)
  # before any ownership proof happens — the exact path a revoked production
  # token takes.
  # fix-ocr17: bound the run — a token that unexpectedly VALIDATES parks the
  # sidecar in its resident renewal loop, `docker compose run` never returns
  # and CI hangs forever. 120s is far beyond the expected fast failure exit;
  # timeout's rc 124 is ≠0 and lands in the same fail path below.
  out="$(OPENBOT_TLS_HOST_DIR="$work" \
    timeout 120 docker compose --project-directory "$repo_root" -f "$repo_root/docker/compose/certs.yml" -p openbot-tls-drill \
    run --rm \
    -e OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE='https://{session}.openbot-tls-drill.net' \
    -e ACME_CA=letsencrypt_test \
    -e ACME_DNS=dns_cf \
    -e CF_Token='invalid-token-injected-by-drill' \
    -e OPENBOT_TLS_ALERT_WEBHOOK='file:/etc/openbot/tls/alerts.jsonl' \
    -e OPENBOT_TLS_RENEW_INTERVAL_SECONDS=600 \
    openbot-tls 2>&1)"
  rc=$?
  printf '%s\n' "$out" | tail -n 20
  docker compose --project-directory "$repo_root" -f "$repo_root/docker/compose/certs.yml" -p openbot-tls-drill \
    down -v --remove-orphans >/dev/null 2>&1 || true

  # The issuance must fail at the ACME/DNS layer — not because the environment
  # broke — and be recorded + alerted; no certificate installed. The status file
  # is the proof the REAL code path ran: the entrypoint reached acme.sh, captured
  # the failure and wrote it down before exiting.
  [ "$rc" -ne 0 ] || fail "the staged issuance unexpectedly SUCCEEDED — inspect the output above"
  pass "staged issuance failed as injected (exit $rc)"
  if [ -f "$work/renewal-status.json" ] \
    && grep -q '"lastAttemptOk":false' "$work/renewal-status.json" \
    && grep -q '"lastAttemptKind":"issue"' "$work/renewal-status.json"; then
    pass "failure recorded in renewal-status.json (issue attempt, failed)"
  else
    fail "the failure was not recorded by the pipeline — the container may have died before reaching acme.sh (see output above)"
  fi
  if [ -f "$work/alerts.jsonl" ] && grep -q '"severity":"critical"' "$work/alerts.jsonl"; then
    pass "staged failure alerted (critical)"
  else
    fail "no critical alert for the staged failure"
  fi
  [ ! -f "$work/cert.pem" ] || fail "a certificate was installed despite the staged failure"
  pass "no certificate installed"

  if [ "${KEEP:-0}" != "1" ]; then rm -rf "$work"; fi
  printf 'live-staging drill: %d assertions passed\n' "$PASS_COUNT"
}

case "$mode" in
  --offline) drill_offline ;;
  --live-staging) drill_live_staging ;;
  *)
    printf 'usage: %s [--offline|--live-staging]\n' "$0" >&2
    exit 2
    ;;
esac
