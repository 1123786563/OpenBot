#!/bin/bash
# MT076 mutation testing (Issue #119) — one mutation at a time, focused suite must fail.
set -u
cd "$(dirname "$0")/../../../../../../server"
MODULE=src/enterprise/tenancy/people-lifecycle.ts
BACKUP=/tmp/mt076-module-backup.ts
RESULTS=../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT076/mutation/results.txt
mkdir -p "$(dirname "$RESULTS")"
cp "$MODULE" "$BACKUP"
source ../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT076/test-env.sh

run_case() {
  local id="$1" desc="$2" from="$3" to="$4"
  python3 - "$MODULE" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
if src.count(frm) < 1:
    print(f"MUT_SETUP_FAIL:{path}: pattern not found: {frm[:60]!r}")
    sys.exit(3)
open(path, "w").write(src.replace(frm, to, 1))
PY
  if [ $? -ne 0 ]; then echo "$id SETUP-FAIL $desc" | tee -a "$RESULTS"; cp "$BACKUP" "$MODULE"; return; fi
  local out
  out=$(bun test tests/multitenancy/people-lifecycle.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)" | tr '\n' ' ')
  local fails
  fails=$(echo "$out" | grep -oE '[0-9]+ fail' | awk '{print $1}')
  if [ "${fails:-0}" -gt 0 ]; then
    echo "$id KILLED (fail=$fails) $desc | suite: $out" | tee -a "$RESULTS"
  else
    echo "$id SURVIVED $desc | suite: $out" | tee -a "$RESULTS"
  fi
  cp "$BACKUP" "$MODULE"
}

: > "$RESULTS"
run_case MUT1  "promote trust check removed" \
 '    async promoteCompanyMember(context, input) {
      assertTrustedAdminContext(context);' \
 '    async promoteCompanyMember(context, input) {
      void context;'

run_case MUT2  "in-transaction admin revalidation removed" \
 '      await revalidateAdmin(tx, context);
      await pinTarget(tx, principalId);' \
 '      await pinTarget(tx, principalId);'

run_case MUT3  "promote epoch not bumped" \
 '          .set({ role: "tenant_admin", epoch })' \
 '          .set({ role: "tenant_admin" })'

run_case MUT4  "promote already-admin guard removed" \
 '        if (membership.role === "tenant_admin") {
          throw new Error("COMPANY_MEMBER_NOT_FOUND");
        }' \
 '        void membership.role;'

run_case MUT5  "demote closed-vocabulary guard removed" \
 '      if (to !== "member" && to !== "auditor") {
        throw new Error("INVALID_REQUEST");
      }' \
 '      void to;'

run_case MUT5b "blank principalId guard removed" \
 '    const principalId = typeof value === "string" ? value.trim() : "";
    if (!principalId) throw new Error("INVALID_REQUEST");
    return principalId;' \
 '    return typeof value === "string" ? value.trim() : "";'

run_case MUT6  "offboard grants deletion loop removed" \
 '        for (const grant of grants) {' \
 '        for (const grant of []) {'

run_case MUT7  "offboard audit write removed" \
 '        const auditEventId = await recordPeopleLifecycleAuditEvent(tx, {
          eventType: "company_member.offboarded",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch,
          details: { grants_deleted: grants.length },
        });' \
 '        const auditEventId = "audit-skipped";'

run_case MUT8  "demote refusal reveals role state (leaky code)" \
 '        if (membership.role !== "tenant_admin") {
          throw new Error("COMPANY_MEMBER_NOT_FOUND");
        }' \
 '        if (membership.role !== "tenant_admin") {
          throw new Error("MEMBER_IS_NOT_ADMIN");
        }'

run_case MUT9  "non-active member guard removed (offboard suspended proceeds)" \
 '      if (membership?.status !== "active") {
        throw new Error("COMPANY_MEMBER_NOT_FOUND");
      }' \
 '      void membership;'

run_case MUT10 "demote admin-precondition removed" \
 '        if (membership.role !== "tenant_admin") {
          throw new Error("COMPANY_MEMBER_NOT_FOUND");
        }' \
 '        void membership.role;'

run_case MUT11 "audit operation_id pin removed" \
 '  const eventId = crypto.randomUUID();
  await tx.execute(
    sql`select set_config('"'"'app.operation_id'"'"', ${eventId}, true)`,
  );' \
 '  const eventId = crypto.randomUUID();'

run_case MUT12 "demote epoch not bumped" \
 '          .set({ role: to, epoch })' \
 '          .set({ role: to })'

run_case MUT13 "offboard suspension write removed" \
 '          .set({ status: "suspended", epoch })' \
 '          .set({ epoch })'

echo "=== baseline sanity after restore ===" | tee -a "$RESULTS"
bun test tests/multitenancy/people-lifecycle.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)" | tee -a "$RESULTS"
diff -q "$BACKUP" "$MODULE" && echo "MODULE RESTORED CLEAN" | tee -a "$RESULTS"
