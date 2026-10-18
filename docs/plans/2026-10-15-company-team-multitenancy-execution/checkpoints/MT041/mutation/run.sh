#!/bin/bash
# MT041 mutation runs: one semantic mutation at a time, focused suite must FAIL
# (mutation killed). Original file restored after each run; final hash re-verified.
set -u
cd /Users/wuyongjun/orca/workspaces/OpenBot/i11-mt041/server || exit 1
SRC=src/enterprise/tenancy/job-ownership.ts
CP=../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT041
ENVSH=$CP/test-env.sh
OUT=$CP/mutation/results.txt
: > "$OUT"

run_case() {
  local id="$1" desc="$2" from="$3" to="$4"
  python3 - "$SRC" "$from" "$to" <<'EOF'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if frm not in s:
    print(f"MUTATION_TARGET_NOT_FOUND: {frm[:60]}")
    sys.exit(2)
open(path, "w").write(s.replace(frm, to, 1))
EOF
  if [ $? -ne 0 ]; then echo "$id TARGET NOT FOUND — aborting" >> "$OUT"; cp /tmp/job-ownership.orig.ts "$SRC"; exit 1; fi
  source "$ENVSH"
  result=$(bun --no-env-file test tests/multitenancy/job-ownership.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)" | tr '\n' ' ')
  echo "$id | $desc | $result" >> "$OUT"
  cp /tmp/job-ownership.orig.ts "$SRC"
}

# MUT1 归属不匹配守卫移除（不同选择标识可返回 existing = 归属可被"接受改写"的假象）
run_case MUT1 "ownership mismatch guard removed (scope compare bypassed)" \
  "if (
          !existing ||
          existing.tenantId !== jobScope.tenantId ||
          existing.workspaceId !== jobScope.workspaceId ||
          existing.principalId !== owner
        ) {" \
  "if (false) {"

# MUT2 幂等分支改为重写（重 pin 重写 creation 快照）
run_case MUT2 "idempotent branch re-writes creation snapshot" \
  "        const [creation] = await tx
          .select()
          .from(jobConfigSnapshots)" \
  "        await tx.insert(jobConfigSnapshots).values({ kind: jobKind, objectId: id, purpose: 'creation', companyRevision: snapshot.companyRevision, overrideRevision: snapshot.overrideRevision, basisDigest: snapshot.basisDigest }).onConflictDoNothing();
        const [creation] = await tx
          .select()
          .from(jobConfigSnapshots)"

# MUT3 认领 workspace 三比移除（同公司跨团队可认领）
run_case MUT3 "claim workspace-equality check removed" \
  "        if (
          pin.tenantId !== jobScope.tenantId ||
          pin.workspaceId !== jobScope.workspaceId
        ) {" \
  "        if (false) {"

# MUT4 未 pin 可认领（pin 缺失守卫移除）
run_case MUT4 "missing-pin guard removed (unpinned job claimable)" \
  "        if (!pin) {
          throw new Error(
            \`\${JOB_LEASE_SCOPE_MISMATCH}: no ownership pin visible in the claimed scope\`,
          );
        }" \
  "        if (!pin) { throw new Error('x'); } if (false) { throw new Error('y'); }"

# MUT5 活租约他人持有守卫移除（可抢活租约）
run_case MUT5 "live-lease-held guard removed" \
  "        const liveForOther =" \
  "        const liveForOther = false &&"

# MUT6 本人活租约幂等分支移除（重复认领当新授予）
run_case MUT6 "iAmLive idempotent branch removed" \
  "        const iAmLive =" \
  "        const iAmLive = false &&"

# MUT7 续约持有人 WHERE 移除（任何人可续约）
run_case MUT7 "renew holder-match removed" \
  "              eq(leaseRow.claimedByKind, holder.kind),
              eq(leaseRow.claimedBy, holder.id),
              sql\`\${jobLeases.finishedAt} is null\`,
            ),
          )
          .returning({ leaseUntil: jobLeases.leaseUntil });" \
  "            ),
          )
          .returning({ leaseUntil: jobLeases.leaseUntil });"

# MUT8 完结持有人 WHERE 移除（任何人可完结他人租约）
run_case MUT8 "finish holder-match removed" \
  "              eq(leaseRow.claimedByKind, holder.kind),
              eq(leaseRow.claimedBy, holder.id),
              sql\`\${jobLeases.finishedAt} is null\`,
            ),
          )
          .returning({ finishedAt: jobLeases.finishedAt });" \
  "            ),
          )
          .returning({ finishedAt: jobLeases.finishedAt });"

# MUT9 重认领 attempts 不推进
run_case MUT9 "reclaim attempts increment removed" \
  "            attempts: sql\`\${jobLeases.attempts} + 1\`," \
  "            attempts: jobLeases.attempts,"

# MUT10 creation 快照写入移除
run_case MUT10 "creation snapshot write removed" \
  "          const [creationRow] = await tx
            .insert(jobConfigSnapshots)" \
  "          const [creationRow] = await tx.select().from(jobConfigSnapshots).where(sql'1=0')."

# MUT11 执行依据 pin 守卫移除
run_case MUT11 "execution-basis pin guard removed" \
  "        if (!pin || pin.workspaceId !== jobScope.workspaceId) {" \
  "        if (false) {"

# MUT12 digest 恒定化（内容绑定失效）
run_case MUT12 "basis digest constant (content binding broken)" \
  "  return createHash(\"sha256\").update(canonical).digest(\"hex\");" \
  "  return createHash(\"sha256\").update('mt041-constant').digest(\"hex\");"

# MUT13 成员列表 workspace 过滤移除
run_case MUT13 "member list workspace filter removed" \
  "  if (workspaceId !== null) {
    conditions.push(eq(jobOwnership.workspaceId, workspaceId));
  }" \
  "  if (false) {
    conditions.push(eq(jobOwnership.workspaceId, workspaceId));
  }"

# MUT14 成员列表 principal 过滤移除（看到他人任务）
run_case MUT14 "member list principal filter removed" \
  "  if (principalId !== null) {
    conditions.push(eq(jobOwnership.principalId, principalId));
  }" \
  "  if (false) {
    conditions.push(eq(jobOwnership.principalId, principalId));
  }"

# MUT15 管理视图受信上下文断言移除
run_case MUT15 "admin trusted-context assertion removed" \
  "    async listJobsForCompanyAdmin(admin, filter) {
      assertTrustedAdminContext(admin);" \
  "    async listJobsForCompanyAdmin(admin, filter) {
      void admin;"

# MUT16 详情 canonical not-found 分支移除
run_case MUT16 "readJob canonical not-found removed" \
  "        if (rows.length === 0) jobNotFound();
        return rows[0];
      });
    },

    async listJobsForCompanyAdmin" \
  "        return rows[0];
      });
    },

    async listJobsForCompanyAdmin"

# MUT17 首次授予 attempts 应为 1（变 0 → 重复执行不可辨）
run_case MUT17 "first-grant attempts pinned to 1 removed" \
  "            leaseUntil: sql\`now() + make_interval(secs => \${ms / 1000})\`,
            attempts: 1," \
  "            leaseUntil: sql\`now() + make_interval(secs => \${ms / 1000})\`,
            attempts: 0,"

# MUT18 释放持有人 WHERE 移除（任何人可释放他人租约）
run_case MUT18 "release holder-match removed" \
  "              eq(leaseRow.claimedByKind, holder.kind),
              eq(leaseRow.claimedBy, holder.id),
              sql\`\${jobLeases.finishedAt} is null\`,
            ),
          )
          .returning({ objectId: leaseRow.objectId });" \
  "            ),
          )
          .returning({ objectId: leaseRow.objectId });"

# 终验：文件与交付哈希逐位一致
sha256sum "$SRC" >> "$OUT"
diff <(sha256sum "$SRC" | awk '{print $1}') <(sha256sum /tmp/job-ownership.orig.ts | awk '{print $1}') \
  && echo "RESTORE-VERIFIED: byte-identical" >> "$OUT" \
  || echo "RESTORE-FAILED" >> "$OUT"
cat "$OUT"
