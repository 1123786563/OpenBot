#!/bin/bash
# MT073 变异自证（二任执行版，task_ac240a9fbe51 / ctx_5c0dee846983）。
# 与计划版 run-mutations.sh 一致：同七项变异语义 M01–M07、同「注入→聚焦捕获→逐字节还原」纪律、
# 同末位 RESTORE 总校验。
# 执行版差异（逐项披露，见 reports/MT073.md）：
#   1. \n 解码：计划版 M03/M04 多行锚点以字面 "\n" 写在 bash 双引号里，python 侧按原样
#      比较，count=0 → ANCHOR-FAIL（计划脚本从未真正跑过，bug 未暴露）；本版在 python 内
#      统一把 "\\n" 解码为真实换行（作者语义即多行锚点）。
#   2. M04 锚点校正：计划版锚点假设 eq(…) 单行排版；真实文件（biome 格式化）eq 拆三行。
#      本版锚点对齐真实字节序列；变异语义不变（WHERE 恒真 → 账户侧公司总额失去客户过滤）。
#   3. 证据增强：每个变异存 M0x-evidence.txt（注入 diff + 聚焦输出 + 失败用例名），且每次
#      还原后立即 SHA-256 与 pristine 比对（计划版只在末尾总校验一次）。
# 运行前置：七变量 env 已 source（0600 文件 /tmp/mt073-env.sh，收尾删除）。
set -uo pipefail
cd "$(dirname "$0")/../../../../../../server" || exit 1

SRC="src/billing/company-finance-visibility.ts"
BAK="/tmp/mt073-mutation-pristine-2nd.ts"
OUT="../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT073/mutation"
EXPECTED_PRISTINE="51c5aa04bf4ce9db989b9f5b6ec81c8ce998bb77d5a9822693369d9a05d7cd98"

cp "$SRC" "$BAK"
PRISTINE_SHA=$(shasum -a 256 "$SRC" | awk '{print $1}')
echo "pristine sha256: $PRISTINE_SHA"
if [[ "$PRISTINE_SHA" != "$EXPECTED_PRISTINE" ]]; then
  echo "PRISTINE-MISMATCH: 当前 SRC 与 after-hashes.txt 基线不一致，拒绝在非 pristine 态注入" | tee -a "$OUT/results.txt"
  exit 1
fi
: > "$OUT/results.txt"
{
  echo "# MT073 变异结果（二任执行版，$(date '+%F %T')）"
  echo "# 计划=run-mutations.sh（M01–M07 语义逐字继承）；执行版差异：\\n 解码、M04 锚点对齐真实格式、逐次还原即校验"
  echo "# pristine sha256: ${PRISTINE_SHA}（=after-hashes.txt company-finance-visibility.ts）"
} >> "$OUT/results.txt"

run_mutation() {
  local id="$1" desc="$2" old="$3" new="$4"
  python3 - "$SRC" "$old" "$new" << 'PYEOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
old, new = old.replace("\\n", "\n"), new.replace("\\n", "\n")
s = open(path).read()
if s.count(old) != 1:
    sys.exit(f"ANCHOR-FAIL: anchor occurs {s.count(old)} times, expected 1")
open(path, "w").write(s.replace(old, new))
PYEOF
  if [[ $? -ne 0 ]]; then
    echo "$id ANCHOR-FAIL" | tee -a "$OUT/results.txt"; cp "$BAK" "$SRC"; return
  fi
  echo "== $id: $desc"
  {
    echo "# $id: $desc"
    echo "# 锚点（解码后）：$old"
    echo "# 注入 diff（pristine -> mutated）："
    diff -u "$BAK" "$SRC" || true
    echo "# 聚焦套件 tests/multitenancy/billing-visibility.test.ts："
    bun --no-env-file test tests/multitenancy/billing-visibility.test.ts --timeout 30000 > "/tmp/mt073-$id-run.txt" 2>&1
    grep -E "^ [0-9]+ (pass|fail)" "/tmp/mt073-$id-run.txt" | tr '\n' ' '
    echo
    echo "# 捕获者（失败用例）："
    grep -E "^\(fail\)" "/tmp/mt073-$id-run.txt" || echo "  （无失败——变异未被捕获！）"
  } > "$OUT/$id-evidence.txt"
  grep -E "^ [0-9]+ (pass|fail)" "/tmp/mt073-$id-run.txt" | tr '\n' ' ' >> "$OUT/results.txt"
  echo " <= $id $desc" >> "$OUT/results.txt"
  cp "$BAK" "$SRC"
  local now_sha
  now_sha=$(shasum -a 256 "$SRC" | awk '{print $1}')
  if [[ "$now_sha" != "$PRISTINE_SHA" ]]; then
    echo "RESTORE-FAILED-after-$id (sha $now_sha)" | tee -a "$OUT/results.txt"
    exit 1
  fi
  echo "# 还原：sha256 与 pristine 逐位一致（${now_sha}）" >> "$OUT/$id-evidence.txt"
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
# 锚点对齐真实文件：eq( 为 biome 多行排版（计划版单行假设 ANCHOR-FAIL，已披露修正）。
run_mutation "M04" "account-side company total loses its customer filter" \
  "            .where(\n              eq(\n                creditReservations.externalCustomerId,\n                mapping.externalCustomerId,\n              ),\n            )" \
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
  echo "RESTORE-VERIFIED byte-identical ($RESTORED_SHA)" | tee -a "$OUT/results.txt"
else
  echo "RESTORE-FAILED" | tee -a "$OUT/results.txt"
  exit 1
fi
rm -f /tmp/mt073-mutation-pristine-2nd.ts /tmp/mt073-M0*-run.txt
