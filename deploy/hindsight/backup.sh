#!/usr/bin/env bash
# Controlled backup of the self-hosted Hindsight database.
#
# Retention: a controlled copy is deleted at the first run once it has existed for
# HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS whole days — see the sweep
# comment below (it runs right after the lock, before the dump) for the exact
# `find -mtime` semantics and the 30-day boundary measurement. The value
# resolves with compose-like precedence: real
# environment first, then the HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS key of the
# hindsight.env next to this script. There is no implicit default: if neither
# layer declares the key, the run fails loudly (see below), because running on
# an undeclared value would silently pick 30 days. Only 1..30 are valid; 0 is
# rejected (see the validation comment below). The declaration layers of the two
# components are NOT the same: this script reads the process environment and the
# hindsight.env next to it, while OpenBot's privacy compliance validation
# (server/src/hindsight/config.ts) reads HINDSIGHT_PRIVACY_* from the OpenBot
# deployment environment only — never from hindsight.env. A declaration only in
# hindsight.env therefore runs this script while the health check still reports
# config_noncompliant; aligning both sides is a deployment-reconciliation task
# (#391), so declare the same number in both layers.
#
# Usage: ./backup.sh [backup-dir]      (default: ./backups next to this script)
# Schedule with cron, e.g. daily at 03:00. The leading mkdir -p guards the log
# redirect: cron applies the redirection before the script runs, so the log
# directory must already exist or the job fails before backup.sh starts:
#   0 3 * * * mkdir -p /path/to/deploy/hindsight/backups && /path/to/deploy/hindsight/backup.sh >> /path/to/deploy/hindsight/backups/backup.log 2>&1
# Concurrency: runs are serialized by a non-blocking exclusive lock on
# backups/.backup.lock — an overlapping run (cron overrun + manual invocation)
# exits 1 instead of racing the dump and the retention sweep. flock is used
# where available; see the lock comment in the body for the no-flock fallback.
#
# Controlled-backup registration (#391, server/src/hindsight/backup-registry.ts):
# every adopted archive gets one manifest beside it,
# `hindsight-<stamp>.manifest.json`, holding
# {"backupId":"hindsight-<stamp>.sql.gz","takenAt":"<ISO 8601 dump-start>"}.
# OpenBot reconciles those manifests into its cleanup-evidence registry when the
# deployment declares HINDSIGHT_BACKUP_MANIFEST_DIR pointing at this directory.
# Manifests are deliberately NOT swept with the archives: the retention sweep
# deleting an archive while its manifest remains is the purge evidence the
# cleanup claim stands on. A run that kills before the manifest is written
# (inside the partial-write window) therefore leaves the archive registered
# nowhere — the cleanup leg stays honestly uncleared rather than guessing.
set -euo pipefail

# Refuse to run under xtrace: `bash -x` echoes expanded command substitutions to
# stderr, and the pg0 manifest read below captures the database password — a
# tracing run would leak it into the terminal and any redirected log (#398 m2).
if [[ $- == *x* ]]; then
  echo "refusing to run: xtrace (bash -x) echoes expanded command substitution, which would include the database password; re-run without -x" >&2
  exit 1
fi

# Backup copies carry the whole memory database; keep them owner-only (0600).
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${1:-$HERE/backups}"
RETENTION_DAYS="${HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS:-}"

# Fallback: when the host environment does not declare the retention, read the same
# key from hindsight.env next to this script — exact anchored KEY= match, last
# occurrence wins (mirrors compose env_file precedence, where the file sits below the
# real environment). One layer of surrounding quotes and a CR line ending are
# tolerated; anything that is not a bare whole number still fails the validation
# below, and a missing file or missing key leaves RETENTION_DAYS empty, which
# fails loudly right after this block. The file's other keys (secrets) are never
# read or echoed.
if [ -z "$RETENTION_DAYS" ] && [ -f "$HERE/hindsight.env" ]; then
  RETENTION_DAYS="$(sed -n 's/^HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=//p' "$HERE/hindsight.env" | tail -n 1)"
  RETENTION_DAYS="${RETENTION_DAYS%$'\r'}"
  case "$RETENTION_DAYS" in
    \"*\")
      RETENTION_DAYS="${RETENTION_DAYS#\"}"
      RETENTION_DAYS="${RETENTION_DAYS%\"}"
      ;;
    \'*\')
      RETENTION_DAYS="${RETENTION_DAYS#\'}"
      RETENTION_DAYS="${RETENTION_DAYS%\'}"
      ;;
  esac
fi

# No implicit default. If neither layer above declared the key, fail loudly
# instead of silently running at 30 days: an implicit default would keep this
# job running while the health check — reading the OpenBot deployment
# environment, not hindsight.env — reports config_noncompliant
# (backup_retention_days), the exact two-component drift this script refuses to
# paper over.
if [ -z "$RETENTION_DAYS" ]; then
  echo "refusing to run: HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS must be declared explicitly (1..30) in the process environment or in the hindsight.env next to this script. Note the two components read different layers: OpenBot's privacy health check (server/src/hindsight/config.ts) reads HINDSIGHT_PRIVACY_* from the OpenBot deployment environment only, never from hindsight.env, so a declaration only in hindsight.env runs this script yet still reports backup_retention_days noncompliant — aligning both sides is a deployment-reconciliation task (#391)" >&2
  exit 1
fi

# The sweep passes RETENTION_DAYS - 1 to find (see below), so the declared value must
# stay inside 1..30. 0 is rejected rather than clamped to 1: the sweep cannot honor a
# zero-day window (every run first WRITES a fresh copy), and clamping would silently
# keep copies up to ~2 days past the declared zero while OpenBot's compliance check —
# which rejects 0 exactly the same way (config.ts pins the same 1..30 domain:
# MIN_BACKUP_RETENTION_DAYS = 1, and validateHindsightPrivacy reports
# backup_retention_days below that floor) — would keep reporting config_noncompliant.
# A missing or out-of-domain declaration therefore fails loudly on both sides:
# declare 1..30 in this script's layers (process environment or hindsight.env)
# AND in the OpenBot deployment environment its health check reads (#391), or do
# not schedule this job at all if no backups are wanted.
if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || [ "$RETENTION_DAYS" -lt 1 ] || [ "$RETENTION_DAYS" -gt 30 ]; then
  echo "refusing to run: HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS must be a whole number between 1 and 30 (got \"${RETENTION_DAYS:-<unset>}\"; to keep no backups, do not schedule this job)" >&2
  exit 1
fi

# `[` compares in base 10, but $(( )) reads a leading zero as octal: an 08/09
# declaration would crash the sweep arithmetic below ("value too great for
# base"), and 030 would silently become 24, sweeping six days earlier than
# declared. Re-base once here; the anchored regex above guarantees digits only,
# so 10#… is always a valid decimal literal, and every later use of the value
# (including the -lt/-gt checks above, which are already decimal) stays exact.
RETENTION_DAYS=$((10#$RETENTION_DAYS))

mkdir -p "$BACKUP_DIR"

# Same-second race guard: an overlapping run (cron overrun + manual invocation)
# would race both the dump and the retention sweep (under a tight retention the
# second sweep could even delete the first run's fresh copy). Take the
# non-blocking exclusive lock backups/.backup.lock for the whole run; when it
# is already held, exit 1 instead of queueing behind the winner. flock is used
# where available (standard on Linux servers; the kernel releases it even if
# the run is killed). On hosts without flock (e.g. stock macOS) an exclusive-
# create lock file stamped with the holder PID and the holder's start time
# (`ps -o lstart=`) emulates it: the EXIT trap removes it, and a lock is
# treated as stale and stolen when its holder PID is no longer alive
# (aliveness by `kill -0` re-checked with `ps -p`, because a live process owned
# by another user only fails `kill -0` with EPERM — see the holder branch
# below) OR when the PID is alive but its current start time no longer matches
# the recorded one (PIDs are recycled: a PID-only check would honor a
# SIGKILLed run's lock forever once a long-lived process received the recycled
# PID — see the holder branch below), so a killed run cannot block all future
# backups. The residual steal race is
# bounded: its worst case is two concurrent runs, i.e. exactly the benign race
# this guard narrows. An empty read (we raced the creator between the exclusive
# create and the lock write) is never treated as stale — retry briefly, then
# refuse loudly, so the guard itself cannot widen the race it closes.
LOCK_FILE="$BACKUP_DIR/.backup.lock"
LOCK_STYLE="flock"
try_create_lock() {
  # The lock carries two fields: the holder PID and the holder's start time
  # (`ps -o lstart=`). The start time is the fingerprint the stale check below
  # compares against the live process to detect a recycled PID (a PID can be
  # alive without being the backup that wrote the lock). lstart output is
  # padded with leading/trailing whitespace on common platforms, so it is
  # trimmed before it is stored; the stale check trims the same way before
  # comparing. When lstart cannot be read, the lock degrades to the legacy
  # single-field form (PID only) — noted here so a bare PID in the file is not
  # mistaken for corruption.
  _lock_lstart="$(ps -p $$ -o lstart= 2>/dev/null || true)"
  _lock_lstart="${_lock_lstart#"${_lock_lstart%%[![:space:]]*}"}"
  _lock_lstart="${_lock_lstart%"${_lock_lstart##*[![:space:]]}"}"
  if [ -n "$_lock_lstart" ]; then
    ( set -o noclobber; printf '%s %s\n' "$$" "$_lock_lstart" > "$LOCK_FILE" ) 2>/dev/null
  else
    ( set -o noclobber; echo "$$" > "$LOCK_FILE" ) 2>/dev/null
  fi
}
if command -v flock >/dev/null 2>&1; then
  # flock(2) provides kernel-level mutual exclusion — among flock USERS. It
  # cannot see the create-style lock below, whose exclusivity lives entirely in
  # this file's CONTENT (the holder's PID+lstart fingerprint), and the two
  # styles can meet on one host (hosts and runs with differing provisioning,
  # or one backup directory shared between differently provisioned machines).
  # So before taking the kernel lock, this branch consults the file's content
  # with the SAME live-holder rules as the create-style path: a parseable, alive
  # fingerprint (PID[+lstart]; same kill -0/ps aliveness check, same lstart
  # match rules) is refused loudly as an overlapping run (the holder may use either lock style); empty, dead or
  # unparseable content falls through. These content checks are host-local:
  # PIDs and lstart values identify processes on THIS machine only, so on a
  # directory shared across hosts they cannot verify (and may misjudge) a
  # holder on another host — cross-host mutual exclusion relies on flock on the
  # shared filesystem, not on this content check.
  # fd 9 is opened for APPEND (>>): a `>` open would truncate the file and erase
  # an existing holder's fingerprint before it could be honored.
  exec 9>>"$LOCK_FILE" || {
    echo "refusing to run: cannot open the lock file $LOCK_FILE" >&2
    exit 1
  }
  LOCK_HOLDER="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  LOCK_PID="${LOCK_HOLDER%% *}"
  case "$LOCK_PID" in
    ''|*[!0-9]*)
      : # empty, or not a fingerprint this script writes — nothing alive to honor
      ;;
    *)
      # Same aliveness check as the create-style path: kill -0 re-checked with
      # ps -p, because a live process owned by another user only fails kill -0
      # with EPERM and must not read as dead here either.
      if kill -0 "$LOCK_PID" 2>/dev/null || ps -p "$LOCK_PID" -o pid= >/dev/null 2>&1; then
        _recorded_lstart="${LOCK_HOLDER#* }"
        if [ "$_recorded_lstart" = "$LOCK_HOLDER" ]; then _recorded_lstart=""; fi
        _recorded_lstart="${_recorded_lstart#"${_recorded_lstart%%[![:space:]]*}"}"
        _recorded_lstart="${_recorded_lstart%"${_recorded_lstart##*[![:space:]]}"}"
        _holder_lstart="$(ps -p "$LOCK_PID" -o lstart= 2>/dev/null || true)"
        _holder_lstart="${_holder_lstart#"${_holder_lstart%%[![:space:]]*}"}"
        _holder_lstart="${_holder_lstart%"${_holder_lstart##*[![:space:]]}"}"
        if [ -n "$_recorded_lstart" ] && [ -n "$_holder_lstart" ] && [ "$_recorded_lstart" != "$_holder_lstart" ]; then
          : # recycled PID: alive, but a different process than the fingerprint's writer — fall through
        else
          echo "refusing to run: a live backup run holds the fingerprint in $LOCK_FILE (pid $LOCK_PID) while this run locks via flock — the holder may use either lock style, because a flock run rewrites the same fingerprint after taking the kernel lock; overlapping runs are not started. If no backup is running, remove the stale file by hand" >&2
          exit 1
        fi
      fi
      ;;
  esac
  if ! flock -n 9; then
    echo "refusing to run: another backup is holding $LOCK_FILE (flock); overlapping runs are not started" >&2
    exit 1
  fi
  # This run now owns the lock both ways: kernel flock held, and the content is
  # empty, stale or dead (any live fingerprint was refused above). Rewrite the
  # file to THIS run's fingerprint, in the same two-field format the create-
  # style path writes (same lstart trim, same PID-only degrade), so the next
  # run of either style reads a consistent, current holder. Truncating here is
  # safe: both styles consult the content only before acquiring.
  _run_lstart="$(ps -p $$ -o lstart= 2>/dev/null || true)"
  _run_lstart="${_run_lstart#"${_run_lstart%%[![:space:]]*}"}"
  _run_lstart="${_run_lstart%"${_run_lstart##*[![:space:]]}"}"
  if [ -n "$_run_lstart" ]; then
    printf '%s %s\n' "$$" "$_run_lstart" > "$LOCK_FILE"
  else
    echo "$$" > "$LOCK_FILE"
  fi
elif try_create_lock; then
  LOCK_STYLE="create"
else
  _tries=0
  while :; do
    LOCK_HOLDER="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    # The holder identity is the lock's FIRST field ("PID lstart…"); a file
    # with no readable first field — the empty-read race, or anything not
    # written by this script — takes the old retry-then-refuse path below.
    LOCK_PID="${LOCK_HOLDER%% *}"
    case "$LOCK_PID" in
      ''|*[!0-9]*)
        if [ "$_tries" -ge 10 ]; then
          echo "refusing to run: $LOCK_FILE exists but holds no readable PID; if no backup is running, remove the stale file by hand" >&2
          exit 1
        fi
        _tries=$((_tries + 1))
        sleep 0.1
        if try_create_lock; then
          LOCK_STYLE="create"
          break
        fi
        ;;
      *)
        # `kill -0` alone cannot decide aliveness here: for a live process owned by another
        # user it fails with EPERM, indistinguishable from the ESRCH of a dead one — and on a
        # shared backup directory (cron as user A, a manual run as user B, both supported) that
        # misread would rm A's live lock and start a second concurrent run. Re-check with
        # `ps -p`, which lists other users' PIDs regardless of signal permission: still listed
        # => alive (the EPERM case), refuse; gone => genuinely dead (ESRCH), steal the lock.
        #
        # A live PID is still not proof of ownership: PIDs are recycled. If a previous run was
        # SIGKILLed (the EXIT trap does not run, and this no-flock fallback is the only lock),
        # a PID-only check would honor its lock FOREVER once any long-lived process received
        # the recycled PID: every later run refuses, the backup chain stops silently, and only
        # cron's backup.log ever shows it. The lock therefore also records the holder's start
        # time; a live PID whose CURRENT `ps -o lstart=` differs from the recorded one belongs
        # to a different process than the one that wrote the lock — treat the lock as stale
        # and steal it. Refusing to run requires a start-time match; without a recorded start
        # time (legacy PID-only locks, or hosts where lstart is unavailable) or a readable
        # current one, reuse cannot be proven either way, so the old refuse behavior stands —
        # degrade to refusing, never to stealing. Both lstart values are trimmed (ps pads
        # them; see try_create_lock) before the comparison.
        LOCK_LSTART="${LOCK_HOLDER#* }"
        if [ "$LOCK_LSTART" = "$LOCK_HOLDER" ]; then LOCK_LSTART=""; fi
        _recorded_lstart="${LOCK_LSTART#"${LOCK_LSTART%%[![:space:]]*}"}"
        _recorded_lstart="${_recorded_lstart%"${_recorded_lstart##*[![:space:]]}"}"
        if kill -0 "$LOCK_PID" 2>/dev/null || ps -p "$LOCK_PID" -o pid= >/dev/null 2>&1; then
          _holder_lstart="$(ps -p "$LOCK_PID" -o lstart= 2>/dev/null || true)"
          _holder_lstart="${_holder_lstart#"${_holder_lstart%%[![:space:]]*}"}"
          _holder_lstart="${_holder_lstart%"${_holder_lstart##*[![:space:]]}"}"
          if [ -n "$_recorded_lstart" ] && [ -n "$_holder_lstart" ] && [ "$_recorded_lstart" != "$_holder_lstart" ]; then
            # Recycled PID: alive, but not the process that wrote the lock.
            # Steal the stale lock it left behind.
            rm -f "$LOCK_FILE"
            if try_create_lock; then
              LOCK_STYLE="create"
            else
              echo "refusing to run: $LOCK_FILE was just claimed by another run after the recycled-PID lock was cleared; overlapping runs are not started" >&2
              exit 1
            fi
          else
            echo "refusing to run: another backup (pid $LOCK_PID) is holding $LOCK_FILE; overlapping runs are not started" >&2
            exit 1
          fi
        else
          rm -f "$LOCK_FILE"
          if try_create_lock; then
            LOCK_STYLE="create"
          else
            echo "refusing to run: $LOCK_FILE was just claimed by another run after the stale lock was cleared; overlapping runs are not started" >&2
            exit 1
          fi
        fi
        break
        ;;
    esac
  done
fi

# Sweep placement: this runs BEFORE the dump chain, directly after the lock. It
# depends only on host-side state validated above (BACKUP_DIR, RETENTION_DAYS) —
# never on the container, its manifest, or a successful dump. Under
# `set -euo pipefail` an end-of-script sweep was skipped whenever any docker/dump
# step failed (container absent, manifest moved, compose drift), so aged copies
# silently stopped being deleted and outlived the declared window: cron only
# writes stderr into backup.log, and the health check has no backup evidence
# (retention windows there are deployment-reconciliation matters, tracked in
# #391). The ≤30-day window is a hard privacy ceiling: a failing dump must not
# extend the lifetime of copies already due for deletion. Sweeping before the
# dump also cannot harm the copy this run is about to write (it does not exist
# yet), so the reordering is safe.
#
# Retention sweep. `find -mtime +N` matches when a file's age, counted in whole
# 24-hour periods (fractional part discarded), is strictly greater than N days.
# Passing +30 therefore only deletes copies that have existed for 31+ WHOLE days
# (a 30.5-day-old copy survives), letting copies linger ~31 days (~32 with a
# daily schedule). To make the declared window the exact threshold we pass
# N = RETENTION_DAYS - 1: any copy is deleted at the first run once it has
# existed for RETENTION_DAYS whole days, so after every run no surviving copy is
# RETENTION_DAYS whole days old or older. Between runs a copy can still exist up
# to one schedule interval past that point (a 30-day window + daily cron
# => worst case ~31 days, versus ~32 before the adjustment).
# The validation above pins RETENTION_DAYS to 1..30, so find's argument stays
# within +0..+29 — the degenerate `-mtime -1` argument that RETENTION_DAYS=0
# would have produced cannot occur.
# Boundary measurement (host `find`, 2026-10-15, POSIX +n semantics shared by
# BSD and GNU find): copies aged 29.0d and 29.5d kept; aged exactly 30.0d,
# 30.5d and 31d matched for deletion — the exact-30-day boundary that +30
# previously let survive is now swept. Re-measured 2026-10-16 after the
# password/temp-file rework: identical result.
#
# Both sweeps are pinned to the top level of BACKUP_DIR with -maxdepth 1 (BSD find
# requires it before the other primaries, as written here): this script only ever
# writes its artifacts DIRECTLY into BACKUP_DIR (never into subdirectories), so the
# depth limit loses none of the script's own coverage while an operator who points
# $1 at a directory shared with other people's data no longer risks recursively
# deleting same-named files living deeper in it.
find "$BACKUP_DIR" -maxdepth 1 -name 'hindsight-*.sql.gz' -type f -mtime "+$((RETENTION_DAYS - 1))" -delete

# Also sweep interrupted leftovers. The EXIT trap removes the current run's partial,
# but it does not run under SIGKILL (OOM killer, kill -9, power loss, kernel panic),
# so a killed run's .hindsight-*.sql.gz.part — a gzip copy of the whole memory
# database — would otherwise linger in backups/ forever, silently past the ≤30-day
# privacy ceiling this script enforces. The manifest's own partial name is swept the
# same way: an abandoned half-written manifest must not read as a registration.
# No -mtime guard here: the lock taken above
# serializes runs, so any partial visible at this point belongs to a killed previous
# run (this run's own partial is only created after the sweep), and an abandoned
# partial has already outlived whatever window it started in.
find "$BACKUP_DIR" -maxdepth 1 \( -name '.hindsight-*.sql.gz.part' -o -name '.hindsight-*.manifest.json.part' \) -type f -delete

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# The dump's start instant: content written before it can be in the copy, so it is
# the conservative "taken before" moment the cleanup evidence measures against.
TAKEN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TARGET="$BACKUP_DIR/hindsight-$STAMP.sql.gz"
# Write to a hidden partial name first: the retention sweep matches
# 'hindsight-*.sql.gz', which never matches this dot-prefixed, .part-suffixed name,
# and the final filename only appears once the archive passed the integrity check.
# The EXIT trap removes the partial on any failure so no corrupt leftover lingers.
PART_TARGET="$BACKUP_DIR/.hindsight-$STAMP.sql.gz.part"
# The registration manifest (see the header): written beside the archive only after
# the integrity check, through its own partial name for the same reason.
MANIFEST="$BACKUP_DIR/hindsight-$STAMP.manifest.json"
MANIFEST_PART="$BACKUP_DIR/.hindsight-$STAMP.manifest.json.part"
# Release the partial and, for the no-flock fallback, the lock file. The
# flock-style lock is released by the kernel when fd 9 closes at exit and its
# file is intentionally kept: deleting a lock file races a waiter that already
# opened it. LOCK_STYLE is only ever "create" when THIS run holds the lock, so
# a refused run never deletes another run's lock.
trap 'rm -f "$PART_TARGET" "$MANIFEST_PART"; if [ "$LOCK_STYLE" = create ]; then rm -f "$LOCK_FILE"; fi' EXIT

# The embedded pg0 database runs inside the container as user `hindsight`. Its binaries
# and credentials are NOT on the container's default PATH/env (pg_dump lives under
# ~/.pg0/installation/<version>/bin); read them from the instance manifest so the script
# keeps working across pg version bumps in the image.
INSTANCE_JSON='/home/hindsight/.pg0/instances/hindsight/instance.json'
CONNECTION="$(docker compose -f "$HERE/docker-compose.yml" exec -T hindsight python -c '
import json
with open("'"$INSTANCE_JSON"'") as f:
    cfg = json.load(f)
print(cfg["installation_dir"] + "/" + cfg["version"] + "/bin/pg_dump")
print(cfg["username"])
print(cfg["password"])
print(cfg["database"])
')"
PG_DUMP_BIN="$(printf '%s\n' "$CONNECTION" | sed -n 1p)"
DB_USER="$(printf '%s\n' "$CONNECTION" | sed -n 2p)"
DB_PASSWORD="$(printf '%s\n' "$CONNECTION" | sed -n 3p)"
DB_NAME="$(printf '%s\n' "$CONNECTION" | sed -n 4p)"

# Shape-check BEFORE use: field 2 is the username and field 3 the password, so
# a short, overlong or empty-line manifest read would silently shift the
# password into `pg_dump --username`, where it leaks into pg_dump's error
# output and from there into the logs. Fail loudly and do NOT echo the captured
# stdout — its lines include the password itself. A newline inside a value also
# lands here (the line protocol cannot carry it: the stdin `read` below would
# misalign the same way).
if [ "$(printf '%s\n' "$CONNECTION" | grep -c '')" -ne 4 ] || [ -z "$PG_DUMP_BIN" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
  echo "refusing to run: the pg0 instance manifest read from the container did not have the expected shape (exactly 4 non-empty lines: pg_dump path, username, password, database); the captured output is not printed because it contains the password" >&2
  exit 1
fi

# The password is delivered to the container over stdin: a plain
# `docker compose exec -e PGPASSWORD=...` would put the secret into the exec's argv,
# where any host user can read it from the process list. Here the container shell
# reads one line from stdin, exports it into its own environment for the exec'd
# pg_dump only, and the secret never appears in any argv on either side.
printf '%s\n' "$DB_PASSWORD" |
  docker compose -f "$HERE/docker-compose.yml" exec -T hindsight sh -c '
    IFS= read -r PGPASSWORD || exit 3
    export PGPASSWORD
    exec "$1" --username "$2" --dbname "$3" --no-owner --no-privileges </dev/null
  ' pg-dump "$PG_DUMP_BIN" "$DB_USER" "$DB_NAME" |
  gzip > "$PART_TARGET"

# Integrity check before adopting the archive: a truncated gzip (killed dump, full
# disk) must not pass as a valid backup. On failure `set -e` aborts and the EXIT trap
# removes the partial; the final name is only created after the check passes.
gzip -t "$PART_TARGET"
mv -f "$PART_TARGET" "$TARGET"

# Register the adopted copy: one manifest, written atomically after the archive exists, so a
# reader never sees a registration for an archive that failed its integrity check. `takenAt`
# is the dump's start instant, not this one — a copy can only be trusted to miss content
# written after it began.
printf '{"backupId":"%s","takenAt":"%s"}\n' "hindsight-$STAMP.sql.gz" "$TAKEN_AT" > "$MANIFEST_PART"
mv -f "$MANIFEST_PART" "$MANIFEST"

echo "backup written: $TARGET (retention ${RETENTION_DAYS}d)"
echo "backup registered: $MANIFEST"
