#!/bin/bash
# MT070 变异测试：对 server/src/billing/company-reservation.ts 逐个注入语义变异，
# 跑聚焦套件，记录 pass/fail；完成后还原并校验 SHA-256 与 pristine 逐位一致。
set -uo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT/server"
SRC=src/billing/company-reservation.ts
BAK=/tmp/mt070-pristine-service.ts
source ../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT070/test-env.sh

PRISTINE=$(sha256sum "$SRC" | cut -d' ' -f1)
cp "$SRC" "$BAK"

mutate() {
  local id="$1" label="$2" patch="$3"
  cp "$BAK" "$SRC"
  if ! perl -0pi -e "$patch" "$SRC"; then echo "MUT $id [$label]: PATCH FAILED"; return; fi
  if cmp -s "$SRC" "$BAK"; then echo "MUT $id [$label]: PATCH NO-OP (anchor not found)"; return; fi
  local out pass fail verdict="SURVIVED"
  local injected
  injected=$(sha256sum "$SRC" | cut -d' ' -f1)
  out=$(bun --no-env-file test tests/multitenancy/company-reservation.test.ts 2>&1 | tail -4)
  pass=$(echo "$out" | awk '/pass$/{print $1}' | head -1 | tr -d ' ')
  fail=$(echo "$out" | awk '/fail$/{print $1}' | head -1 | tr -d ' ')
  [ -n "$fail" ] && [ "$fail" != "0" ] && verdict="KILLED"
  cp "$BAK" "$SRC"
  local restored
  restored=$(sha256sum "$SRC" | cut -d' ' -f1)
  local restore_ok="OK"; [ "$restored" != "$PRISTINE" ] && restore_ok="MISMATCH"
  echo "MUT $id [$label]: pass=$pass fail=$fail -> $verdict | injected=$injected restored=$restored restore-vs-pristine=$restore_ok"
}

# M01 客户端付款账户守卫移除（守卫条件恒 false，伪造客户键被静默剥掉）
mutate M01 "payer-fixed-guard-removed" 's/if \(smuggled !== undefined\)/if (smuggled !== undefined \&\& false)/'
# M02 公司映射必填守卫移除（无映射 → 空引用崩溃，而非类型化哨兵）
mutate M02 "mapping-required-removed" 's/if \(!mapping\) \{/if (false) {/'
# M03 公司账户核验移除（映射客户上没有活跃公司账户也放行 → 空引用崩溃）
mutate M03 "company-account-check-removed" 's/account\?\.status !== "active" \|\|/false ||/'
# M04 成员预检移除（非成员可消费公司余额）
mutate M04 "member-precheck-removed" 's/if \(membership\?\.status !== "active"\)/if (membership?.status !== "active" \&\& false)/'
# M05 团队预检移除（跨公司团队可挂在公司名下）
mutate M05 "workspace-precheck-removed" 's/if \(!workspace\)/if (workspace \&\& false)/'
# M06 call_key 预检移除（同调用标识可二次预扣，直至唯一索引才拦）
mutate M06 "callkey-precheck-removed" 's/existingCall &&\n        existingCall\.idempotencyKey !== input\.idempotencyKey/existingCall \&\& false \&\&\n        existingCall.idempotencyKey !== input.idempotencyKey/s'
# M07 归属行字段交换写入（botRef/callKey 对调，归属事实失真）
mutate M07 "attribution-fields-swapped" 's/botRef: input\.botRef,\n            callKey: input\.callKey,/botRef: input.callKey,\n            callKey: input.botRef,/s'
# M08 归属漂移比对移除（重放任意改归属静默通过）
mutate M08 "attribution-drift-allowed" 's/return \(\n      row\.tenantId.*?\n    \);/return true;/s'
# M09 23505 兜底退持移除（竞态败者留下幻影持有限额 + 裸 23505）
mutate M09 "unique-race-release-removed" 's/if \(isUniqueViolation\(error\)\) \{/if (isUniqueViolation(error) \&\& false) {/'
# M10 汇总租户过滤移除（团队汇总跨公司泄漏）
mutate M10 "usage-summary-tenant-filter-removed" 's/\.where\(eq\(billingCallAttributions\.tenantId, tenantId\)\)\n        \.groupBy\(billingCallAttributions\.workspaceId\)/.groupBy(billingCallAttributions.workspaceId)/s'
# M11 重放幂等键放行移除（同幂等键的合法重放被 call_key 预检误杀）
mutate M11 "replay-allowance-removed" 's/existingCall &&\n        existingCall\.idempotencyKey !== input\.idempotencyKey/existingCall !== undefined/s'
# M12 上界拒绝形状破坏（refused 报成 reserved，工作在未定价上界下放行）
mutate M12 "ceiling-refusal-inverted" 's/if \(!hold\.reserved\) \{\n        return hold;/if (!hold.reserved) {\n        return { reserved: true as const, reservationId: `cr-mutated` };/s'

cp "$BAK" "$SRC"
RESTORED=$(sha256sum "$SRC" | cut -d' ' -f1)
echo "pristine: $PRISTINE"
echo "restored: $RESTORED"
if [ "$PRISTINE" = "$RESTORED" ]; then echo "RESTORE: byte-identical OK"; else echo "RESTORE: MISMATCH"; fi
