#!/bin/bash
# MT073 变异自证：每个安全语义 ≥1 个单点变异 → 注入 → 聚焦套件 → 逐字节还原。
# 还原后 SHA-256 必须与 pristine 逐位一致（RESTORE 验证在脚本末尾）。
set -uo pipefail
cd "$(dirname "$0")/../../../../../server" || exit 1

SRC="src/billing/company-finance-visibility.ts"
BAK="/tmp/mt073-mutation-pristine.ts"
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT073/mutation"

cp "$SRC" "$BAK"
PRISTINE_SHA=$(shasum -a 256 "$SRC" | awk '{print $1}')
echo "pristine sha256: $PRISTINE_SHA"
: > "$OUT/results.txt"

run_mutation() {
  local id="$1" desc="$2" old="$3" new="$4"
  python3 - "$SRC" "$old" "$new" << 'PYEOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if s.count(old) != 1:
    sys.exit(f"ANCHOR-FAIL: anchor occurs {s.count(old)} times, expected 1")
open(path, "w").write(s.replace(old, new))
PYEOF
  if [[ $? -ne 0 ]]; then echo "$id ANCHOR-FAIL" | tee -a "$OUT/results.txt"; cp "$BAK" "$SRC"; return; fi
  echo "== $id: $desc"
  bun test tests/multitenancy/billing-visibility.test.ts --timeout 30000 2>&1 | grep -E "^ [0-9]+ (pass|fail)" | tr '\n' ' ' >> "$OUT/results.txt"
  echo " <= $id $desc" >> "$OUT/results.txt"
  cp "$BAK" "$SRC"
}

# M01 判定门移除：授权行/活跃成员缺一不再拒绝。
run_mutation "M01" "gate removed (grant-row/active checks bypassed)" \
  "      if (!row || !memberActive) {" \
  "      if (false && (!row || !memberActive)) {"

# M02 成员资格活查移除：停用成员不再失效。
run_mutation "M02" "live active-membership check removed" \
  "    return membership?.status === \"active\";" \
  "    return membership !== undefined;"

# M03 撤销退化为 no-op：删行匹配不到任何行（revoked:false 且账簿仍可读）。
run_mutation "M03" "revocation delete matches nothing" \
  "            eq(billingCompanyFinanceGrants.principalId, input.principalId),\n          ),\n        )\n        .returning();" \
  "            eq(billingCompanyFinanceGrants.principalId, input.principalId),\n            sql\`false\`,\n          ),\n        )\n        .returning();"

# M04 公司总额口径放宽：账户侧过滤移除（个人直连混入）。
run_mutation "M04" "account-side company total loses its customer filter" \
  "            .where(\n              eq(creditReservations.externalCustomerId, mapping.externalCustomerId),\n            )" \
  "            .where(\n              sql\`true or \${creditReservations.externalCustomerId} = \${mapping.externalCustomerId}\`,\n            )"

# M05 重复授权放行：FINANCE_GRANT_EXISTS 拒绝移除（DB 唯一索引兜底为裸 23505）。
run_mutation "M05" "duplicate-grant refusal removed" \
  "      if (existing) {" \
  "      if (false && existing) {"

# M06 grantor 资格预检移除（复合 FK 兜底为裸 23503）。
run_mutation "M06" "grantor membership precheck removed" \
  "      if (!(await activeMembership(input.tenantId, input.grantedBy))) {" \
  "      if (false && !(await activeMembership(input.tenantId, input.grantedBy))) {"

# M07 grantee 资格预检移除（复合 FK 兜底为裸 23503）。
run_mutation "M07" "grantee membership precheck removed" \
  "      if (!(await activeMembership(input.tenantId, input.principalId))) {" \
  "      if (false && !(await activeMembership(input.tenantId, input.principalId))) {"

RESTORED_SHA=$(shasum -a 256 "$SRC" | awk '{print $1}')
echo "restored sha256: $RESTORED_SHA"
if [[ "$RESTORED_SHA" == "$PRISTINE_SHA" ]]; then
  echo "RESTORE-VERIFIED byte-identical" | tee -a "$OUT/results.txt"
else
  echo "RESTORE-FAILED" | tee -a "$OUT/results.txt"
  exit 1
fi
