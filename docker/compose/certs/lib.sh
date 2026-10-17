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
# fix-ocr19 #6: the acme.sh binary, defined HERE (the exported layer every
# sourcing script shares) rather than in entrypoint.sh — run_renewal below is
# the SHARED renewal body (the entrypoint loop and the drill both ride it), and
# it must drive the same binary the entrypoint's issue/install paths honor: an
# ACME_BIN override (the tests' fake-acme seam, a wrapper shim) that the
# hardcoded `acme.sh` in run_renewal silently ignored renewed through a binary
# that may not exist on PATH. Same default, one definition, every caller.
ACME_BIN="${ACME_BIN:-acme.sh}"
# fix-ocr18 #10: the numeric knobs ride ONE guard. A non-numeric env value
# (a letter-rot `864OO`, a float, a negative, empty) used to flow straight into
# the guard's integer arithmetic — `[ $((now - last_at)) -ge "$cooldown" ]`
# errored, the comparison read false, and the alerter was silently DISARMED by
# a typo. The standing rule is 宁可误报, so a bad value falls back to the
# default with a WARN (the entrypoint INTERVAL's own precedent), never into a
# comparison that fails open.
tls_numeric() {
  case "$1" in
    '' | *[!0-9]*)
      log "WARN: numeric value '$1' is not a whole number; using the default ($2)"
      printf '%s' "$2"
      ;;
    *) printf '%s' "$1" ;;
  esac
}
tls_warn_days() { tls_numeric "${OPENBOT_TLS_WARN_DAYS:-30}" 30; }
tls_crit_days() { tls_numeric "${OPENBOT_TLS_CRIT_DAYS:-14}" 14; }
tls_alert_cooldown_seconds() {
  tls_numeric "${OPENBOT_TLS_ALERT_COOLDOWN_SECONDS:-86400}" 86400
}

log() { printf 'openbot-tls %s\n' "$*" >&2; }

# ── on-disk certificate directory name (fix-ocr17) ────────────────────────────
# acme.sh normalizes a `*.` wildcard to `_.` in its on-disk domain directory
# (`*.preview.example.com` lives under `<home>/_.preview.example.com_ecc`).
# Pure POSIX parameter expansion — the sidecar's strict-POSIX sh rejects bash's
# `${var/pat/rep}` substitution with "Bad substitution", which used to crash
# the whole startup path right at the restart fast path (fix-ocr8 #1's
# regression class). Pure, so scripts/tls-pipeline.test.ts can pin the exact
# `_.<base>_ecc` shape and its survival under a non-bash sh.
wildcard_cert_dir() {
  printf '%s/_.%s_ecc' "$1" "${2#*.}"
}

# ── preview-host derivation ────────────────────────────────────────────────────────
#
# Mirrors #361's parseTemplate (server/src/craft/preview-origin.ts): the template is a
# FULL URL, `{session}` appears exactly once as the hostname's leading label, no
# path/query/fragment (a path would smuggle the basePath footgun back in). The
# certificate covers exactly ONE label below the base (D3/D7): `*.<base>` matches
# `<hash>.<base>` and nothing deeper. An empty template is the D5 dev form —
# `127.0.0.1:<port>` needs no certificate at all, so the pipeline SKIPS. An http
# template is INVALID (fix-ocr18 #9, aligned with the server's fix-ocr4 #9): the
# preview pass cookie is SameSite=None; Secure, which a plain-http origin can
# never accept, so the server closes admission on it — a former skip here was a
# drift that burned LE quota issuing for a template no browser could use. A base
# of exactly `localhost` stays SKIP: the server explicitly supports the local
# testing form (`https://{session}.localhost:3001`), but no public CA can issue
# for the reserved domain — a recorded divergence, harmless by construction.
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
  # …but it must still be a whole number within WHATWG's port range: `:8443x` is
  # a typo (#361's URL parser rejects it too; review-F2 golden set),
  # `:70000` is a template the server's `new URL()` THROWS on (fix-ocr18 #8 —
  # a digits-only check used to derive ok here and the sidecar burned LE quota
  # issuing for a certificate the server will never address), and `:0` is
  # refused on BOTH sides since fix-ocr26 #9 (WHATWG accepts it, but it has no
  # serving meaning — the server's parseTemplate now refuses it too, and this
  # side's `-lt 1` floor already did; neither face serves what the other
  # refuses). A BARE trailing
  # `:` is not a port at all — WHATWG normalizes the empty port to "no port"
  # and the server's parseTemplate accepts the template, so this side must
  # agree or it would crash-loop against a template the server serves fine
  # (fix-ocr4 #5). Leading zeros are WHATWG-legal (`:0443` IS 443), so the
  # range check reads the zero-stripped VALUE, not the digit count.
  if [ -n "$port" ] && [ "$port" != ":" ]; then
    if ! printf '%s' "$port" | grep -Eq '^:[0-9]+$'; then
      printf 'invalid|%s\n' "$usage"
      return 1
    fi
    portnum="$(printf '%s' "$port" | sed 's/^:0*//')"
    [ -n "$portnum" ] || portnum=0
    # The length pre-check keeps the numeric compare inside long-friendly
    # territory: anything 6+ digits is over-range by construction, so the
    # -gt below never sees an arbitrarily long operand.
    if [ "${#portnum}" -gt 5 ] || [ "$portnum" -lt 1 ] || [ "$portnum" -gt 65535 ]; then
      printf 'invalid|%s\n' "$usage"
      return 1
    fi
  fi
  if [ -z "$base" ] || ! printf '%s' "$base" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'; then
    printf 'invalid|%s\n' "$usage"
    return 1
  fi
  # fix-ocr19 #9 (measured alignment, recorded): this regex ACCEPTS empty
  # interior labels (`a..b`) and boundary hyphens (`a-.b`) — and so does the
  # server: WHATWG's domain-to-ASCII takes both (UTS 46 CheckHyphens is off),
  # so parseTemplate serves those templates. The sidecar therefore KEEPS the
  # lax form — a stricter regex here would crash-loop the sidecar against a
  # template the server serves. The agreement is pinned on both faces
  # (scripts/tls-pipeline.test.ts and server/tests/craft-preview-origin.test.ts,
  # the two `a..b`/`a-.b` golden cases); tightening either side updates both.

  if [ "$scheme" = "http" ]; then
    # fix-ocr18 #9: INVALID, matching the server's fix-ocr4 #9 refusal —
    # cross-referenced golden sets on both sides
    # (scripts/tls-pipeline.test.ts / server/tests/craft-preview-origin.test.ts).
    printf 'invalid|OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE must be https — the preview cookie is SameSite=None; Secure, which browsers refuse on a plain-http origin (server fix-ocr4 #9)\n'
    return 1
  fi
  if [ "$base" = "localhost" ]; then
    # fix-ocr18 #9: the recorded divergence — the server explicitly supports
    # the local testing form, and no public CA can issue for the reserved
    # domain; skip, never a failed issuance loop.
    printf 'skip|localhost base: the local testing form the server supports cannot be certified by a public CA (reserved domain)\n'
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
  # fix-ocr17: anything that is not a plain number is a corrupted/truncated
  # timestamp — a fragment here used to explode the $((now - last_at))
  # arithmetic inside the command substitution and the guard silently evaluated
  # to "no alert" (the exact silence this pipeline exists to prevent). The
  # standing rule is 宁可误报: corrupt ⇒ fire, exactly like never-alerted.
  case "$last_at" in
    '' | null | *[!0-9]*) printf 'fire' ; return 0 ;;
  esac
  if [ "$last_severity" = "warn" ] && [ "$severity" = "critical" ]; then
    printf 'fire' # escalation beats the cooldown
    return 0
  fi
  # fix-ocr5 J: the cooldown dedupes ONE incident's re-fires — and after a
  # recovery alert wrote lastAlertSeverity=ok, the previous incident is
  # CLOSED. A non-ok state seen then is a NEW incident (ok→critical had no
  # immediate-fire counterpart to warn→critical's, so a fresh fault inside
  # the window sat silent for up to the whole cooldown).
  if [ "$last_severity" = "ok" ]; then
    printf 'fire' # a new incident after a recovery is a new incident
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
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\u0022/g' -e 's/,/\\u002c/g' -e 's/}/\\u007d/g' -e 's/[[:cntrl:]]/ /g' | tr '\n' ' '
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

# status_lock_recycle_stale <lock-dir> — the stale-lock recycle verdict shared
# by status_set and status_lock_acquire (fix-ocr5 F's rule + fix-ocr8 #2's
# TOCTOU discipline, verbatim): a lock older than 60s can only be a crashed
# holder — the held window is the file rewrite itself, milliseconds — but the
# age verdict is stale the moment it is taken, so it is re-verified before any
# removal, and a young lock with a live owner is never ours to touch. Answers
# 0 when a recycle was attempted (retry the mkdir), 1 when the lock must be
# waited on.
status_lock_recycle_stale() {
  rlock="$1"
  if ! find "$rlock" -maxdepth 0 -mmin +1 2>/dev/null | grep -q .; then
    return 1
  fi
  # Test seam (fix-ocr8 #2): pause INSIDE the recycle window — after the
  # first age check, before the removal — so a test can replay the TOCTOU
  # race deterministically. Never set in production.
  if [ -n "${OPENBOT_TLS_RECYCLE_HOOK:-}" ]; then
    sh -c "$OPENBOT_TLS_RECYCLE_HOOK" || true
  fi
  # fix-ocr8 #2: the age verdict is stale the moment it is taken. Between
  # that check and the removal, a concurrent recycler may have removed the
  # corpse and a new acquirer re-created the lock as its own (fresh,
  # owner alive) — removing it blindly would delete a LIVE lock and two
  # writers would hold the same critical section. Re-verify before any
  # removal: recycle when the directory is STILL old (holds are
  # milliseconds, so a 60s-old directory is a corpse even if its recorded
  # PID looks alive — PID reuse), or when it is young but its recorded
  # owner is provably dead (a re-creation that crashed since). A young
  # lock with a live owner — or no readable owner yet, i.e. an acquirer
  # microseconds into its own critical section — is never ours to touch.
  if find "$rlock" -maxdepth 0 -mmin +1 2>/dev/null | grep -q .; then
    log "status_lock: recycling stale lock $rlock (older than 60s — crashed holder?)"
    # rm -rf, not rmdir: a NEW-format corpse still carries its owner file,
    # and rmdir only removes empty directories.
    rm -rf "$rlock" 2>/dev/null || true
  else
    lock_owner="$(cat "$rlock/owner" 2>/dev/null)"
    case "$lock_owner" in
      '' | *[!0-9]*) : ;; # young + ownerless: someone is mid-acquire — leave it
      *)
        if ! kill -0 "$lock_owner" 2>/dev/null; then
          log "status_lock: recycling stale lock $rlock (owner $lock_owner is gone)"
          rm -rf "$rlock" 2>/dev/null || true
        fi
        ;;
    esac
  fi
  return 0
}

# status_lock_acquire <status-file> / status_lock_release <status-file>
# (fix-ocr22 #5): bracket a CALLER's multi-step critical section with the SAME
# mkdir lock status_set uses. status_set serializes ONE write; the guard's
# alert decision is wider — read lastAlert* → judge → send_alert → write
# lastAlert* — and two concurrent guards interleaving it both read the
# pre-alert cooldown and both page. Every status_set inside such a section
# rides the holder's lock via the owner==$$ fast path instead of
# deadlocking on it.
status_lock_acquire() {
  acl_file="$1"
  acl_lock="$(dirname "$acl_file")/.lock"
  acl_spins=0
  while [ "$acl_spins" -lt 50 ]; do
    if mkdir "$acl_lock" 2>/dev/null; then
      printf '%s\n' "$$" >"$acl_lock/owner" 2>/dev/null || true
      return 0
    fi
    if [ "$(cat "$acl_lock/owner" 2>/dev/null)" = "$$" ]; then
      return 0 # already ours (a nested acquire inside our own section)
    fi
    if status_lock_recycle_stale "$acl_lock"; then
      continue # a corpse was recycled — retry the mkdir immediately
    fi
    acl_spins=$((acl_spins + 1))
    sleep 0.1
  done
  # The same 5s-then-degrade contract as status_set (a SIGKILLed holder is
  # recovered by the recycle rule above; anything still stuck after 5s is
  # written through): an alert is too important to drop behind a corpse.
  log "status_lock: lock $acl_lock stuck; proceeding without it (alert dedupe degrades to best-effort)"
  return 1
}

status_lock_release() {
  rel_file="$1"
  rel_lock="$(dirname "$rel_file")/.lock"
  if [ "$(cat "$rel_lock/owner" 2>/dev/null)" = "$$" ]; then
    # rm -rf, not rmdir: the release must remove our own owner file with the
    # directory (an rmdir against a non-empty directory would silently fail
    # and leave the lock behind for every later call to spin against).
    rm -rf "$rel_lock" 2>/dev/null || true
  fi
  return 0
}

# status_set file key value — read-modify-write preserving the other keys.
#
# The whole read-modify-write is serialized by an ATOMIC mkdir lock (fix-ocr4
# #4): the healthcheck (a separate process, on its 60s cadence) and the
# entrypoint main loop (record_attempt's seven writes; the guard's 4–6) used
# to interleave freely, and every writer rewrites the WHOLE file from its own
# read — the last writer's snapshot won and the other's field silently
# vanished (a lost lastAlertAt defeats the cooldown into nonstop paging; a
# lost lastAttemptOk/health swallows an AC8 failure alert). mkdir is atomic
# even on busybox, and the held window is the file rewrite itself:
# milliseconds. fix-ocr22 #5: a caller INSIDE a status_lock_acquire section
# (the guard's judge→alert run) is already the serialized writer — the
# owner==$$ check below rides that lock instead of deadlock-spinning on it,
# and `held` stays empty so nothing releases a lock it did not take.
status_set() {
  file="$1"
  key="$2"
  value="$3"
  lock="$(dirname "$file")/.lock"
  held=""
  # fix-ocr22 #5: the owner==$$ fast path — our own critical section's lock.
  already_held=""
  if [ "$(cat "$lock/owner" 2>/dev/null)" = "$$" ]; then
    already_held=1
  fi
  spins=0
  # fix-ocr5 F: a SIGKILLed holder leaves .lock behind forever — without this
  # every later call spins the full 5s and then writes WITHOUT the lock (the
  # exact lost-field bug the lock exists to prevent, back through the unlocked
  # door). The held window is the file rewrite itself — milliseconds — so the
  # 60s age threshold is ~4 orders of magnitude above any legitimate hold: a
  # lock that old can only be a corpse. Recycle it once and retry the mkdir;
  # when find(1) cannot express the age probe the guard degrades to the old
  # bounded-spin-then-write-anyway behavior (graceful, never worse).
  recycled=""
  while [ "$spins" -lt 50 ] && [ -z "$already_held" ]; do
    if mkdir "$lock" 2>/dev/null; then
      held=1
      # fix-ocr8 #2: name the holder. The recycle path (below) checks this
      # PID's liveness before removing any lock it did not create — without
      # it, a re-created lock has no readable ownership at all.
      printf '%s\n' "$$" >"$lock/owner" 2>/dev/null || true
      break
    fi
    if [ -z "$recycled" ] && status_lock_recycle_stale "$lock"; then
      recycled=1
      continue
    fi
    spins=$((spins + 1))
    sleep 0.1
  done
  if [ -z "$held" ] && [ -z "$already_held" ]; then
    # Stuck after 5s (a crashed holder leaves the directory behind; no trap
    # games here — a trap set inside a sourced function clobbers the sourcing
    # script's own). Write anyway: the alert paths feed this function, and
    # writing risks one torn clobber where NOT writing guarantees exactly the
    # lost field the lock exists to prevent.
    # fix-ocr26 #11: the already_held case is NOT this — there the caller's
    # own critical section (fix-ocr22 #5) holds the lock and the write is as
    # serialized as it gets; logging "stuck; writing without it" for it was a
    # false alarm on every in-section write (every guard --once run), and it
    # drowned the one signal that says real contention: an actual 5s spin.
    log "status_set: lock $lock stuck; writing without it"
  fi
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
  } >"$tmp"
  # Test seam (fix-ocr4 #4): pause between the read and the publish so a test
  # can hold a second writer's full write inside this window. Never set in
  # production — only scripts/tls-pipeline.test.ts passes it.
  if [ -n "${OPENBOT_TLS_STATUS_SET_HOOK:-}" ]; then
    sh -c "$OPENBOT_TLS_STATUS_SET_HOOK"
  fi
  mv "$tmp" "$file"
  if [ -n "$held" ]; then
    # rm -rf, not rmdir: the release must remove our own owner file with the
    # directory (an rmdir against a non-empty directory would silently fail
    # and leave the lock behind for every later call to spin against).
    rm -rf "$lock" 2>/dev/null || true
  fi
}

# record_restart — the container-restart fast path (fix-ocr4 #7). A restart
# is NOT an attempt: acme.sh ran, nothing resolved. The old fast path recorded
# a SUCCESSFUL issue, clobbering a possibly-failing lastAttemptOk/lastError —
# the guard then read a fake recovery (critical→ok) and fired a false recovery
# alert while the real failure signal stayed silent until acme.sh's 60-day
# renewal window surfaced it. A restart proves only that time passed:
# timestamp-class fields move, attempt-truth fields do not.
record_restart() {
  file="$(tls_status_file)"
  now="$(date +%s)"
  status_set "$file" lastRestartAt "$now"
  status_set "$file" updatedAt "$now"
  return 0
}

# ── first-issuance failure backoff (fix-ocr5 H) ───────────────────────────────
# The counter file's home + readers/writers. The schedule is PURE so tests pin
# it directly; the entrypoint owns the increment (on failure) and the reset
# (on success — a successful issue clears the slate, so the next deployment
# problem starts back at the short end).
issue_backoff_file() { printf '%s/.issue-failures' "$(tls_dir)"; }

issue_failure_count() {
  ib_count=0
  if [ -f "$(issue_backoff_file)" ]; then
    ib_count="$(cat "$(issue_backoff_file)" 2>/dev/null)"
    case "$ib_count" in
      '' | *[!0-9]*) ib_count=0 ;; # absent/corrupt: degrade, never explode
    esac
  fi
  printf '%s' "$ib_count"
}

# Seconds to sleep before exit 1, keyed by the CONSECUTIVE-failure count:
# 5s/30s/2m/10m, 30m capped. A flat `sleep 5` against Docker's restart backoff
# retried LE validation multiple times per hour — 5 failures per account per
# hour is Let's Encrypt's limit, so one bad deployment (bad DNS credential,
# wrong base) could burn the account's hourly budget and lock out EVERY
# deployment on that account. The cap (30m) bounds the worst-case retry rate
# at 2/hour; the renewal loop's own interval (≥600s) is untouched. busybox
# sleep takes integer seconds — the schedule stays integral on purpose.
issue_backoff_seconds() {
  case "$1" in
    1) printf '%s' 5 ;;
    2) printf '%s' 30 ;;
    3) printf '%s' 120 ;;
    4) printf '%s' 600 ;;
    *) printf '%s' 1800 ;;
  esac
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
  digest=''
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
  # fix-ocr21 #5: no digest → the JSON null, bare — the sentinel used to be
  # written QUOTED (the string "null"), and an openssl-less host wrote the
  # empty string: neither is a scalar a consumer can read as "no digest".
  # lastAttemptError above already rides bare null on this same path, and a
  # bare null also overwrites a stale digest when an attempt succeeds after
  # a failure (read-modify-write preserves keys; only an assignment clears).
  if [ -n "$digest" ]; then
    status_set "$file" lastErrorDigest "\"$digest\""
  else
    status_set "$file" lastErrorDigest "null"
  fi
  if [ "$ok" = "1" ]; then status_set "$file" lastSuccessAt "$now"; fi
  status_set "$file" updatedAt "$now"
  return 0
}

# ── renewal execution (shared by the entrypoint loop and the drill) ─────────────
# fix-ocr4 #6: pick the hasher EXPLICITLY. The old `sha256sum | cut || shasum |
# cut` took the pipeline's last exit code — cut's, always 0 — so the shasum
# branch was dead code and a host without sha256sum got the EMPTY string (the
# drill's "untouched (sha256)" assertion then passed vacuously).
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  else
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  fi
}

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
    out="$("$ACME_BIN" --cron --home "${ACME_HOME:-/etc/openbot/tls/acme-home}" --log "${ACME_HOME:-/etc/openbot/tls/acme-home}/acme.sh.log" 2>&1)"
    rc=$?
  fi
  # fix-ocr20 #6: the hash is taken BEFORE the rc branch — acme.sh --cron can
  # renew AND install the new certificate (the registered reloadcmd runs
  # inside --install-cert) yet still exit non-zero, a reload-adjacent failure
  # after the install. Recording that shape as a failed attempt used to hold
  # a critical alarm for WEEKS against a certificate that had been renewed
  # (the next real renewal is ~60 days out).
  after="$(sha_of "$dir/cert.pem")"
  if [ "$rc" -ne 0 ]; then
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      # The certificate CHANGED: the renewal itself succeeded; the exit code
      # is a reload-class failure. Record ok — the summary stays observable
      # in lastAttemptError — and say so in the log, never "renewal failed".
      record_attempt 1 renew "reload-class failure after install (exited $rc): $(printf '%s' "$out" | tail -n 5 | tr '\n' ' ' | head -c 300)"
      log "renewal installed a NEW certificate but exited $rc — reload-class failure, not renewal-failed; recorded ok (summary in lastAttemptError)"
      return 0
    fi
    record_attempt 0 renew "renewal exited $rc: $(printf '%s' "$out" | tail -n 5 | tr '\n' ' ' | head -c 300)"
    log "renewal FAILED (exit $rc) — guard will alert; the installed certificate keeps serving"
    return "$rc"
  fi
  # fix-ocr8 #3: an EMPTY before (cert.pem was missing — the critical|missing
  # state) with a NON-empty after is a restored installation, not "not due".
  # The pre-fix `-n "$before"` guard recorded nothing there, so a session that
  # lost its certificate kept lastAttemptOk=false forever and the guard held
  # the critical alarm up after the recovery. "after changed to non-empty" is
  # the success; both empty (nothing due, nothing installed) still records
  # nothing, and rc 0 with an unchanged non-empty before stays "not due".
  if [ -n "$after" ] && [ "$after" != "$before" ]; then
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

# ── alert delivery ──────────────────────────────────────────────────────────────
# Every alert is a log line (container logs → Alloy → Loki: alertable with LogQL
# even without any webhook configured) plus, when OPENBOT_TLS_ALERT_WEBHOOK is set,
# an http(s) POST (generic JSON, GlitchTip/Slack-bridge friendly) or a file:<path>
# JSONL append (the drill and CI use this to observe alerts deterministically).
#
# The two halves are SEPARATE functions (fix-ocr26 #11): the guard's --once
# critical section emits alert_log — cheap, no network, the durable signal
# docs/tls-certs.md's zero-config Loki rule selects on — and delivers
# alert_webhook only AFTER the lock is released. A -m 15 curl INSIDE the mutex
# outlasted the lock's 5s spin budget, let a concurrent guard degrade past the
# held lock, read the pre-alert cooldown state, and double-page — the mutual
# exclusion failing exactly when delivery is slowest. send_alert remains the
# combined form for callers with no critical section.
alert_message() {
  reason="$1"
  days="$2"
  cert="$(json_scalar "$(tls_status_file)" certificate)"
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
  printf '%s' "$message"
}

alert_log() {
  severity="$1"
  reason="$2"
  days="$3"
  host="$(json_scalar "$(tls_status_file)" previewHost)"
  message="$(alert_message "$reason" "$days")"
  # The alert marker is a STANDALONE line: `openbot-tls-alert …`, deliberately NOT a
  # `log`-prefixed `openbot-tls alert …` (review F1) — docs/tls-certs.md's zero-config
  # Loki rule selects on exactly this substring, so the two spellings must never drift
  # apart again (a unit test pins the marker).
  printf 'openbot-tls-alert severity=%s reason=%s days_left=%s preview_host=%s message="%s"\n' \
    "$severity" "$reason" "$days" "${host:-?}" "$message" >&2
}

alert_webhook() {
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
  message="$(alert_message "$reason" "$days")"
  payload="$(printf '{"source":"openbot-tls","severity":"%s","reason":"%s","message":"%s","previewHost":"%s","certificate":"%s","health":"%s","daysLeft":"%s","lastAttemptOk":%s,"lastErrorDigest":%s,"hint":"docker logs openbot-tls and /acme-home/acme.sh.log inside the container"}' \
    "$severity" "$reason" "$(json_escape "$message")" "${host:-}" "${cert:-}" "$severity" "$days" \
    "$attempt_ok" "$digest_raw")"

  webhook="${OPENBOT_TLS_ALERT_WEBHOOK:-}"
  case "$webhook" in
    http://*)
      # fix-ocr22 #7: an http:// target ships the alert payload — acme error
      # text included — out of the host UNENCRYPTED, over whatever hops lie
      # between. Same register as the OWNER/numeric WARNs (宁可误报): say it,
      # in a grep-able line, then deliver anyway — the operator chose the URL.
      log "WARN: OPENBOT_TLS_ALERT_WEBHOOK is plain http:// — the alert payload (acme error text included) leaves this host in cleartext"
      curl -fsS -m 15 -X POST "$webhook" -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1 \
        || log "alert webhook delivery failed (continuing; the log line above is the durable signal)"
      ;;
    https://*)
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

send_alert() {
  alert_log "$@"
  alert_webhook "$@"
}

# ── OPENBOT_TLS_OWNER discipline (fix-ocr17) ──────────────────────────────────
# reload.sh's chown target: ONLY an explicit uid:gid pair is honored. A bare
# uid fed the old "${owner%%:*}:${owner#*:}" assembly spells uid:uid — the
# chown then quietly CHANGED THE GROUP. Anything else yields the empty string,
# which the caller must treat as "skip the chown, log a WARN" (宁可跳过不改组).
# Pure, so the tls-pipeline test pins the discipline without a root chown.
owner_uid_gid() {
  case "$1" in
    *:*) printf '%s:%s' "${1%%:*}" "${1#*:}" ;;
    *) printf '' ;;
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
    # The dir comes EITHER as $2 (test seam convention, exported for
    # run_renewal and the OPENBOT_TLS_RENEW_CMD children) or — as the failure
    # drill invokes it — through an already-exported OPENBOT_TLS_DIR.
    [ -n "${2:-}" ] && export OPENBOT_TLS_DIR="$2"
    run_renewal || exit $?
    ;;
  __status-set)
    # Test seam for the concurrency suite: raw status_set access.
    export OPENBOT_TLS_DIR="${2:?dir}"
    status_set "$(tls_status_file)" "${3:?key}" "${4:?value}"
    ;;
  __numeric)
    # Test seam (fix-ocr18 #10): the numeric-env guard's pure decision.
    # ${2-}, not ${2:?}: an EMPTY value is one of the bad shapes under test.
    tls_numeric "${2-}" "${3:?default}"
    ;;
  __sha-of)
    sha_of "${2:?file}"
    printf '\n'
    ;;
  __cert-dir)
    # Test seam (fix-ocr17): the wildcard→`_.` directory-name normalization.
    wildcard_cert_dir "${2:?home}" "${3:?certificate}"
    printf '\n'
    ;;
  __owner-uid-gid)
    # Test seam (fix-ocr17): reload.sh's chown-target discipline.
    owner_uid_gid "${2:?value}"
    printf '\n'
    ;;
  __record-restart)
    # The restart fast path's seam (fix-ocr4 #7): timestamps, not attempt truth.
    export OPENBOT_TLS_DIR="${2:?dir}"
    record_restart
    ;;
  __backoff)
    # The backoff schedule's pure seam (fix-ocr5 H).
    issue_backoff_seconds "${2:?count}"
    printf '\n'
    ;;
  "")
    : # executed with no command: nothing to do (still exit 0)
    ;;
  *)
    printf 'lib.sh is a library; the only commands are __derive, __days-left, __record-attempt, __run-renewal, __status-set, __numeric, __sha-of, __cert-dir, __owner-uid-gid, __record-restart, __backoff\n' >&2
    exit 2
    ;;
esac
