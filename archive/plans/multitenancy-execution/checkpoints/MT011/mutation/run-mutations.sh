#!/bin/bash
# MT011 mutation harness: apply one surgical mutation, run the focused suite,
# record the outcome, restore the pristine file byte-identically.
set -uo pipefail
SERVER=/Users/wuyongjun/orca/workspaces/OpenBot/i8-mt011/server
CKPT=/Users/wuyongjun/orca/workspaces/OpenBot/i8-mt011/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT011/mutation
TARGET=src/enterprise/tenancy/not-found-semantics.ts
PRISTINE=/tmp/mt011-pristine-not-found-semantics.ts
cd "$SERVER"

export ENTERPRISE_TEST_SETUP_DATABASE_URL='postgresql://postgres@127.0.0.1:55482/openbot_enterprise_mt011' TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55482/openbot_enterprise_mt011' MT003_ASSIGNED_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55482/openbot_enterprise_mt011_assigned' ENTERPRISE_TEST_DIRECTORY_DATABASE_URL='postgresql://ent_mt011_dir:mt011-dir-pw@127.0.0.1:55482/openbot_enterprise_mt011' ENTERPRISE_TEST_DATA_DATABASE_URL='postgresql://ent_mt011_data:mt011-data-pw@127.0.0.1:55482/openbot_enterprise_mt011' ENTERPRISE_TEST_OPERATOR_DATABASE_URL='postgresql://ent_mt011_opr:mt011-opr-pw@127.0.0.1:55482/openbot_enterprise_mt011'

mutate() {
  python3 - "$1" <<'PYEOF'
import sys
mid = sys.argv[1]
path = "src/enterprise/tenancy/not-found-semantics.ts"
src = open(path).read()
if mid == "MUT1":
    # canonical verdict code drift (acceptance 1/4: the one deny shape)
    old = 'Object.freeze({ outcome: "deny", code: "RESOURCE_NOT_FOUND" })'
    new = 'Object.freeze({ outcome: "deny", code: "RESOURCE_MISSING" })'
elif mid == "MUT2":
    # list filter removed — invisible objects enter the visible stream (acceptance 2)
    old = 'if (!evaluateRow(row, scope, options?.policyVersion)) continue;'
    new = 'if (false) continue;'
elif mid == "MUT3":
    # cursor pins to the last CANDIDATE (incl. invisible) row — shift leak (acceptance 2)
    old = '''        for (const row of rows) {
          if (!evaluateRow(row, scope, options?.policyVersion)) continue;'''
    new = '''        for (const row of rows) {
          boundaryRow = row;
          if (!evaluateRow(row, scope, options?.policyVersion)) continue;'''
elif mid == "MUT4":
    # forbidden-but-existing batch denial gets a distinguishable code (acceptance 3)
    old = '''          if (evaluateRow(row, scope, options?.policyVersion)) {
            return Object.freeze({
              resourceId,
              outcome: "allow",
              resource: rowToView(row),
            });
          }
          return Object.freeze({
            resourceId,
            outcome: "deny",
            code: "RESOURCE_NOT_FOUND",
          });'''
    new = '''          if (evaluateRow(row, scope, options?.policyVersion)) {
            return Object.freeze({
              resourceId,
              outcome: "allow",
              resource: rowToView(row),
            });
          }
          return Object.freeze({
            resourceId,
            outcome: "deny",
            code: "ACCESS_DENIED",
          });'''
elif mid == "MUT5":
    # explicit policy-version override dropped (list = decide parity)
    old = 'const effectiveVersion = policyVersion ?? facts.resource.policyRevision;'
    new = 'const effectiveVersion = facts.resource.policyRevision;'
elif mid == "MUT6":
    # shape guard laxity: extra fields would wear the not-found shape (acceptance 1)
    old = '''    candidate.outcome === "deny" &&
    candidate.code === "RESOURCE_NOT_FOUND" &&
    Object.keys(candidate).length === 2'''
    new = '''    candidate.outcome === "deny" &&
    candidate.code === "RESOURCE_NOT_FOUND"'''
else:
    raise SystemExit(f"unknown mutation {mid}")
if src.count(old) != 1:
    raise SystemExit(f"{mid}: anchor not unique (count={src.count(old)})")
open(path, "w").write(src.replace(old, new))
PYEOF
}

run_one() {
  local mid="$1"
  cp "$PRISTINE" "$TARGET"
  if ! mutate "$mid"; then echo "$mid: MUTATION-ANCHOR-FAILED"; exit 2; fi
  bun test tests/multitenancy/not-found-semantics.test.ts --timeout 30000 > "$CKPT/$mid.log" 2>&1
  local rc=$?
  local summary
  summary=$(grep -E "^ [0-9]+ (pass|fail)" "$CKPT/$mid.log" | tr '\n' ' ')
  cp "$PRISTINE" "$TARGET"
  if [ $rc -eq 0 ]; then
    echo "$mid: SURVIVED ($summary)"
  else
    echo "$mid: captured ($summary)"
  fi
}

for m in MUT1 MUT2 MUT3 MUT4 MUT5 MUT6; do
  run_one "$m"
done

# RESTORE-green: pristine byte-identity + focused suite green + biome clean
echo "--- RESTORE verification ---"
sha256sum "$TARGET" "$PRISTINE"
bun test tests/multitenancy/not-found-semantics.test.ts --timeout 30000 > "$CKPT/RESTORE-green.log" 2>&1 && echo "focused suite: green" || echo "focused suite: RED"
bunx biome check src/enterprise/tenancy/not-found-semantics.ts > "$CKPT/RESTORE-biome.log" 2>&1 && echo "biome: clean" || echo "biome: DIRTY"
