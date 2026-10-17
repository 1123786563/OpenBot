#!/bin/sh
# docker/compose/certs/lib.sh — the shared library of the TLS certificate pipeline
# (#359, spec craft-preview-origin D8/AC8).
#
# Sourced by entrypoint.sh / renewal-guard.sh / drill-renewal-failure.sh inside the
# acme.sh sidecar (docker/compose/certs.yml) and on the host by the drill. STRICT
# POSIX sh — the sidecar image (neilpang/acme.sh) is Alpine with no bash. No
# jq/python either, so the status file is written by hand and read back with
# json_raw(): every field is a SCALAR we wrote ourselves, and json_escape() keeps
# commas and braces out of the values, which is what makes the regex read honest.
#
# Test seam: `lib.sh __derive <template>`, `lib.sh __record-attempt <dir> <ok> <kind> <error>`
# and `lib.sh __run-renewal` exist for scripts/tls-pipeline.test.ts, which spawns
# the real production code paths rather than a reimplementation.

# ── files and knobs (env overridable; defaults match the compose service) ──────────
tls_dir() { printf '%s' "${OPENBOT_TLS_DIR:-/etc/openbot/tls}"; }
tls_status_file() { printf '%s/renewal-status.json' "$(tls_dir)"; }
tls_cert_file() { printf '%s/cert.pem' "$(tls_dir)"; }
tls_key_file() { printf '%s/key.pem' "$(tls_dir)"; }
tls_warn_days() { printf '%s' "${OPENBOT_TLS_WARN_DAYS:-30}"; }
tls_crit_days() { printf '%s' "${OPENBOT_TLS_CRIT_DAYS:-14}"; }
tls_alert_cooldown_seconds() { printf '%s' "${OPENBOT_TLS_ALERT_COOLDOWN_SECONDS:-86400}"; }

log() { printf 'openbot-tls %s\n' "$*" >&2; }

# ── preview-host derivation ────────────────────────────────────────────────────────
#
# Mirrors #361's parseTemplate (server/src/craft/preview-origin.ts): the template is a
# FULL URL, `{session}` appears exactly once as the hostname's leading label, no
# path/query/fragment (a path would smuggle the basePath footgun back in). The
# certificate covers exactly ONE label below the base (D3/D7): `*.<base>` matches
# `<hash>.<base>` and nothing deeper. An empty template is the D5 dev form —
# `127.0.0.1:<port>` needs no certificate at all, so the pipeline SKIPS. An http
# template serves the preview origin over plain HTTP: nothing to issue, skip too.
#
# Output: "ok|<scheme>|<baseHostname>" | "skip|<reason>" (exit 0) | "invalid|<reason>" (exit 1).
#
# Edge rulings (the review-F2 golden set, pinned case by case in
# scripts/tls-pipeline.test.ts). Wherever #361's parseTemplate is laxer than this,
# the server side is #362's to tighten — this side does not mirror laxness, it
# fails loudly:
#   - `{session}` is CASE-SENSITIVE: only the literal lowercase form is the
#     placeholder (`{Session}` is a typo, not a template);
#   - leading/trailing whitespace is trimmed (parseTemplate's raw.trim());
#     whitespace INSIDE is a typo, not something to silently strip;
#   - a port must be a whole number (`:8443x` is a typo); a valid port is none of
#     the certificate's business and is stripped;
#   - userinfo (`user@host`), a trailing-dot host (`preview.example.com.`),
#     raw-unicode IDN labels and underscore labels are rejected: no browser ever
#     sends the userinfo, an absolute-form hostname in the config is a typo, a
#     certificate must carry the punycode (xn--) form to ever match the wire, and
#     public CAs (LE included) refuse underscore hostnames anyway.
derive_preview_host() {
  template="$1"
  usage='OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE must be an http(s) URL with lowercase {session} exactly once as the hostname leading label, e.g. https://{session}.preview.example.com'

  value="$(printf '%s' "$template" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$value" ]; then
    printf 'skip|dev form (D5): 127.0.0.1 preview origin, no wildcard certificate needed\n'
    return 0
  fi
  if printf '%s' "$value" | grep -q '[[:space:]]'; then
    printf 'invalid|%s\n' "$usage"
    return 1
  fi

  # {session} exactly once, CASE-SENSITIVE, counted before any lowercasing
  # ({session} is literal in sed BRE; & and \ are not present).
  without="$(printf '%s' "$value" | sed 's/{session}//g')"
  count=$(( (${#value} - ${#without}) / 9 ))

  if [ "$count" -ne 1 ]; then
    printf 'invalid|%s\n' "$usage"
    return 1
  fi

  # URL normalization like the server's `new URL()`: scheme and host lowercase.
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  case "$value" in
    http://* | https://*) scheme="${value%%://*}" ;;
    *)
      printf 'invalid|%s\n' "$usage"
      return 1
      ;;
  esac
  rest="${value#*://}"
  authority="${rest%%[/?#]*}"
  tail="${rest#"$authority"}"
  if [ -n "$tail" ] && [ "$tail" != "/" ]; then
    printf 'invalid|%s\n' "$usage"
    return 1
  fi

  case "$authority" in
    '{session}.'*) hostport="${authority#'{session}'.}" ;;
    *)
      printf 'invalid|%s\n' "$usage"
      return 1
      ;;
  esac
  base="${hostport%%:*}"
  port="${hostport#"$base"}" # a port is none of the certificate's business…
  # …but it must still be a whole number: `:8443x` is a typo, not a port (#361's
  # URL parser rejects it too; review-F2 golden set).
  if [ -n "$port" ] && ! printf '%s' "$port" | grep -Eq '^:[0-9]+$'; then
    printf 'invalid|%s\n' "$usage"
    return 1
  fi
  if [ -z "$base" ] || ! printf '%s' "$base" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'; then
    printf 'invalid|%s\n' "$usage"
    return 1
  fi

  if [ "$scheme" = "http" ]; then
    printf 'skip|template uses http: the preview origin is served plain HTTP, no certificate to issue\n'
    return 0
  fi
  printf 'ok|%s|%s\n' "$scheme" "$base"
}

# ── certificate state ──────────────────────────────────────────────────────────────
#
# Whole days left, floored, via `openssl x509 -checkend` (portable across
# OpenSSL/LibreSSL; `-enddate` parsing is not). Binary search, ~9 invocations.
cert_days_left() {
  cert="$1"
  [ -f "$cert" ] || { printf 'missing'; return 0; }
  lo=0
  hi=400
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1 || { printf 'expired'; return 0; }
  while [ "$lo" -lt "$hi" ]; do
    mid=$(( (lo + hi + 1) / 2 ))
    if openssl x509 -in "$cert" -noout -checkend $((mid * 86400)) >/dev/null 2>&1; then
      lo=$mid
    else
      hi=$((mid - 1))
    fi
  done
  printf '%s' "$lo"
}

# ── health + alert decision (pure) ─────────────────────────────────────────────────
#
# "critical|<reason>" | "warn|<reason>" | "ok|-" | "starting|<reason>". The
# certificate's own state (missing/expired) outranks the last attempt's, so the most
# precise truth wins — with one carve-out (review F4): no certificate AND no attempt
# record at all means the very first issuance is still in flight (DNS-01 propagation
# alone takes minutes); that is "starting": not red, not alertable. Any recorded
# attempt — success or failure — means issuance already resolved, and a missing
# certificate is then genuinely critical.
decide_health() {
  days="$1"
  attempt_ok="$2"
  warn="$3"
  crit="$4"
  case "$days" in
    expired) printf 'critical|%s' "$days"; return 0 ;;
    missing)
      if [ "$attempt_ok" = "none" ]; then
        printf 'starting|first-issuance'
        return 0
      fi
      printf 'critical|%s' "$days"
      return 0
      ;;
  esac
  if [ "$attempt_ok" = "false" ]; then
    printf 'critical|renewal-failed'
    return 0
  fi
  if [ "$days" -le "$crit" ]; then
    printf 'critical|expiring'
    return 0
  fi
  if [ "$days" -le "$warn" ]; then
    printf 'warn|expiring'
    return 0
  fi
  printf 'ok|-'
}

# Whether an alert fires this evaluation: degraded states fire on transition or
# after the cooldown, a warn→critical ESCALATION fires immediately, and a return
# to ok fires exactly one recovery notice. "fire" | "suppress".
should_alert() {
  severity="$1"
  last_severity="$2"
  last_at="$3"
  now="$4"
  cooldown="$5"
  if [ "$severity" = "ok" ]; then
    case "$last_severity" in
      warn | critical) printf 'fire' ;;
      *) printf 'suppress' ;;
    esac
    return 0
  fi
  if [ -z "$last_at" ] || [ "$last_at" = "null" ]; then
    printf 'fire'
    return 0
  fi
  if [ "$last_severity" = "warn" ] && [ "$severity" = "critical" ]; then
    printf 'fire' # escalation beats the cooldown
    return 0
  fi
  if [ $((now - last_at)) -ge "$cooldown" ]; then
    printf 'fire'
    return 0
  fi
  printf 'suppress'
}

# ── status file (scalar JSON, hand-written) ────────────────────────────────────────
# Escapes \u0022 for ", \u002c for comma and \u007d for } so no value ever contains
# a byte that ends the "[^,}]*" read or the status_set key enumeration — a bare
# `"` in a value (e.g. an acme.sh error with embedded JSON) used to be read back
# as a ghost key and rotted the file on every rewrite (High#1). String values
# are otherwise one line.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\u0022/g' -e 's/,/\\u002c/g' -e 's/}/\\u007d/g' | tr '\n' ' '
}

# json_raw file key → the scalar verbatim (`"text"`, number, true/false, null).
json_raw() {
  [ -f "$1" ] || return 0
  grep -o "\"$2\":[^,}]*" "$1" 2>/dev/null | head -1 | cut -d: -f2- | sed 's/^ *//' || true
}

# json_scalar file key → the scalar with string quotes stripped (for logic).
json_scalar() {
  json_raw "$1" "$2" | tr -d '"'
}

# status_set file key value — read-modify-write preserving the other keys.
status_set() {
  file="$1"
  key="$2"
  value="$3"
  [ -f "$file" ] || printf '{\n"schema": 1\n}\n' >"$file"
  tmp="${file}.tmp.$$"
  {
    printf '{"schema": 1'
    grep -o '"[^"]*":' "$file" | tr -d '":' | sort -u | while IFS= read -r k; do
      [ "$k" = "schema" ] && continue
      [ "$k" = "$key" ] && continue
      printf ',\n"%s":%s' "$k" "$(json_raw "$file" "$k")"
    done
    printf ',\n"%s":%s\n}' "$key" "$value"
  } >"$tmp" && mv "$tmp" "$file"
}

# record_attempt <ok 0|1> <kind issue|renew> <error summary, may be empty>
# The entrypoint loop (and the drill, through the same seam) records every issue/
# renewal outcome here; the guard consumes it on its next evaluation.
record_attempt() {
  ok="$1"
  kind="$2"
  error="${3:-}"
  file="$(tls_status_file)"
  now="$(date +%s)"
  digest='null'
  message='null'
  if [ -n "$error" ]; then
    digest="$(printf '%s' "$error" | openssl dgst -sha256 2>/dev/null | awk '{print $NF}' | cut -c1-16)"
    message="\"$(json_escape "$(printf '%s' "$error" | head -c 200)")\""
  fi
  ok_json=false
  [ "$ok" = "1" ] && ok_json=true
  status_set "$file" lastAttemptOk "$ok_json"
  status_set "$file" lastAttemptAt "$now"
  status_set "$file" lastAttemptKind "\"$kind\""
  status_set "$file" lastAttemptError "$message"
  status_set "$file" lastErrorDigest "\"$digest\""
  if [ "$ok" = "1" ]; then status_set "$file" lastSuccessAt "$now"; fi
  status_set "$file" updatedAt "$now"
  return 0
}

# ── renewal execution (shared by the entrypoint loop and the drill) ─────────────
sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

# Runs one renewal cycle (`acme.sh --cron`, or OPENBOT_TLS_RENEW_CMD when set —
# the failure drill's seam) and records the attempt: rc≠0 → failed attempt; rc 0
# with a changed cert.pem → successful renewal (acme.sh already replayed the
# registered reloadcmd by the time this returns); rc 0 unchanged → not due.
run_renewal() {
  dir="$(tls_dir)"
  before="$(sha_of "$dir/cert.pem")"
  if [ -n "${OPENBOT_TLS_RENEW_CMD:-}" ]; then
    out="$(sh -c "$OPENBOT_TLS_RENEW_CMD" 2>&1)"
    rc=$?
  else
    out="$(acme.sh --cron --home "${ACME_HOME:-/etc/openbot/tls/acme-home}" --log "${ACME_HOME:-/etc/openbot/tls/acme-home}/acme.sh.log" 2>&1)"
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    record_attempt 0 renew "renewal exited $rc: $(printf '%s' "$out" | tail -n 5 | tr '\n' ' ' | head -c 300)"
    log "renewal FAILED (exit $rc) — guard will alert; the installed certificate keeps serving"
    return "$rc"
  fi
  after="$(sha_of "$dir/cert.pem")"
  if [ -n "$before" ] && [ "$after" != "$before" ]; then
    record_attempt 1 renew ""
    log "certificate renewed and reloaded (reload.sh ran via the registered reloadcmd)"
  fi
  return 0
}

# ── DNS provider credential table ──────────────────────────────────────────────────
# The plugin list is open (acme.sh ships ~150); these are the documented ones
# (docs/tls-certs.md). Checks NAME presence only — a value is never logged.
dns_missing_credentials() {
  provider="$1"
  case "$provider" in
    dns_cf)
      if [ -z "${CF_Token:-}" ] && { [ -z "${CF_Key:-}" ] || [ -z "${CF_Email:-}" ]; }; then
        printf 'CF_Token (or CF_Key + CF_Email)'
      fi
      ;;
    dns_ali)
      if [ -z "${Ali_Key:-}" ] || [ -z "${Ali_Secret:-}" ]; then printf 'Ali_Key + Ali_Secret'; fi
      ;;
    dns_dp)
      if [ -z "${DP_Id:-}" ] || [ -z "${DP_Key:-}" ]; then printf 'DP_Id + DP_Key'; fi
      ;;
    dns_huaweicloud)
      if [ -z "${HUAWEICLOUD_Username:-}" ] || [ -z "${HUAWEICLOUD_Password:-}" ]; then
        printf 'HUAWEICLOUD_Username + HUAWEICLOUD_Password'
      fi
      ;;
    dns_desec)
      if [ -z "${DESEC_TOKEN:-}" ]; then printf 'DESEC_TOKEN'; fi
      ;;
    *) ;; # not in the documented table: proceed, acme.sh itself will say what it misses
  esac
}

# ── alert delivery ─────────────────────────────────────────────────────────────────
# Every alert is a log line (container logs → Alloy → Loki: alertable with LogQL
# even without any webhook configured) plus, when OPENBOT_TLS_ALERT_WEBHOOK is set,
# an http(s) POST (generic JSON, GlitchTip/Slack-bridge friendly) or a file:<path>
# JSONL append (the drill and CI use this to observe alerts deterministically).
send_alert() {
  severity="$1"
  reason="$2"
  days="$3"
  file="$(tls_status_file)"
  host="$(json_scalar "$file" previewHost)"
  cert="$(json_scalar "$file" certificate)"
  attempt_ok="$(json_scalar "$file" lastAttemptOk)"
  [ -n "$attempt_ok" ] || attempt_ok=null
  digest_raw="$(json_raw "$file" lastErrorDigest)"
  [ -n "$digest_raw" ] || digest_raw=null
  case "$reason" in
    missing) message="The wildcard certificate files are missing under $(tls_dir)." ;;
    expired) message="The wildcard certificate for ${cert:-the preview origin} has EXPIRED." ;;
    renewal-failed)
      message="The wildcard certificate renewal for ${cert:-the preview origin} keeps failing; the old certificate still serves while it lasts."
      ;;
    expiring) message="The wildcard certificate for ${cert:-the preview origin} expires in about ${days} day(s) and has not renewed yet." ;;
    recovery) message="The wildcard certificate for ${cert:-the preview origin} renewed successfully; alerts are cleared." ;;
    *) message="TLS pipeline state: $reason" ;;
  esac
  payload="$(printf '{"source":"openbot-tls","severity":"%s","reason":"%s","message":"%s","previewHost":"%s","certificate":"%s","health":"%s","daysLeft":"%s","lastAttemptOk":%s,"lastErrorDigest":%s,"hint":"docker logs openbot-tls and /acme-home/acme.sh.log inside the container"}' \
    "$severity" "$reason" "$(json_escape "$message")" "${host:-}" "${cert:-}" "$severity" "$days" \
    "$attempt_ok" "$digest_raw")"

  # The alert marker is a STANDALONE line: `openbot-tls-alert …`, deliberately NOT a
  # `log`-prefixed `openbot-tls alert …` (review F1) — docs/tls-certs.md's zero-config
  # Loki rule selects on exactly this substring, so the two spellings must never drift
  # apart again (a unit test pins the marker).
  printf 'openbot-tls-alert severity=%s reason=%s days_left=%s preview_host=%s message="%s"\n' \
    "$severity" "$reason" "$days" "${host:-?}" "$message" >&2

  webhook="${OPENBOT_TLS_ALERT_WEBHOOK:-}"
  case "$webhook" in
    http://* | https://*)
      curl -fsS -m 15 -X POST "$webhook" -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1 \
        || log "alert webhook delivery failed (continuing; the log line above is the durable signal)"
      ;;
    file:*)
      printf '%s\n' "$payload" >>"${webhook#file:}" || log "alert file delivery failed"
      ;;
    "") : ;;
    *) log "OPENBOT_TLS_ALERT_WEBHOOK must be http(s)://… or file:/path; ignoring" ;;
  esac
}

# ── test/driver harness (execution only — a sourced lib.sh stays silent) ───────────
# POSIX sourcing guard: executed, $0 IS this file; sourced from a sibling script it
# is not, and the harness must not fire.
case "$0" in
  *lib.sh) ;;
  *) return 0 ;;
esac

case "${1:-}" in
  __derive)
    result="$(derive_preview_host "${2:-}")"
    printf '%s\n' "$result"
    case "$result" in
      invalid*) exit 1 ;;
    esac
    ;;
  __days-left)
    cert_days_left "${2:?cert path}"
    printf '\n'
    ;;
  __record-attempt)
    # Accept 0/1 or true/false so tests read naturally.
    export OPENBOT_TLS_DIR="${2:?dir}"
    case "${3:?ok}" in
      1 | true) record_attempt 1 "${4:?kind}" "${5:-}" ;;
      *) record_attempt 0 "${4:?kind}" "${5:-}" ;;
    esac
    ;;
  __run-renewal)
    run_renewal || exit $?
    ;;
  "")
    : # executed with no command: nothing to do (still exit 0)
    ;;
  *)
    printf 'lib.sh is a library; the only commands are __derive, __days-left, __record-attempt, __run-renewal\n' >&2
    exit 2
    ;;
esac
