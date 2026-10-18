#!/usr/bin/env bash
# MT036 变异测试 runner。每个变异：外科手术式替换 → 确认与 pristine 有 diff →
# 聚焦套件必须失败（捕获）→ 逐字节还原 → sha256 复验 → 还原后复绿。
set -u
cd "$(dirname "$0")/../../../../../.."
SERVER=server
PRISTINE=/tmp/mt036-pristine
AUTH=$SERVER/src/enterprise/tenancy/kb-ownership.ts
ENTRY=$SERVER/src/kb/application/service/kb-restricted-query.ts
OUTDIR=docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT036/mutation
source /tmp/mt036-env.sh

run_focused() {
  (cd $SERVER && bun --no-env-file test tests/multitenancy/kb-ownership.test.ts --timeout 120000 2>&1 | grep -E "[0-9]+ (pass|fail)$|^Ran")
}

fail_count() {
  grep -E "[0-9]+ fail$" "$1" | head -1 | awk '{print $1}'
}

mutate_and_run() {
  local id="$1" target="$2" perl_expr="$3" desc="$4"
  echo "=== $id: $desc ==="
  cp "$target" "/tmp/mt036-mutant-$id.tmp"
  perl -0pi -e "$perl_expr" "$target"
  if diff -q "$target" "/tmp/mt036-mutant-$id.tmp" >/dev/null; then
    echo "MUTATION-NOT-APPLIED (aborting mutant)"; rm -f "/tmp/mt036-mutant-$id.tmp"; return 1
  fi
  rm -f "/tmp/mt036-mutant-$id.tmp"
  run_focused > "$OUTDIR/$id.log" 2>&1
  local fails=$(fail_count "$OUTDIR/$id.log")
  cp "$PRISTINE/$(basename "$target")" "$target"
  local now=$(sha256sum "$target" | awk '{print $1}')
  local want=$(sha256sum "$PRISTINE/$(basename "$target")" | awk '{print $1}')
  if [ "$now" != "$want" ]; then echo "RESTORE-FAILED"; exit 9; fi
  echo "$id captured_fails=$fails (restored ok)"
  tail -4 "$OUTDIR/$id.log"
  echo ""
}

# --- 权威模块变异 ---
mutate_and_run MUT1 "$AUTH" 's/eq\(enterpriseResources\.kind, KNOWLEDGE_RESOURCE_KIND\),\n\s*//g' "kind 过滤移除（authorize+list）"
mutate_and_run MUT2 "$AUTH" 's/if \(verdict\.outcome === "allow"\) visible\.push\(registration\);/visible.push(registration);/g' "列表注册表求值移除"
mutate_and_run MUT3 "$AUTH" 's/if \(snapshot\.syncVersion !== kbSyncVersionOf\(registration\)\) \{/if (false) {/' "同步版本比对移除"
mutate_and_run MUT6 "$AUTH" 's/if \(snapshot\.workspaceId !== registration\.workspaceId\) \{/if (false) {/' "workspace 比对移除"
# MUT4a：仅权威模块信任门移除（预期存活——入口门冗余兜底，MT008 MUT3a 同款披露）
mutate_and_run MUT4a "$AUTH" 's/^( *)assertTrustedScope\(scope\);\n( *return kbReadTransaction)/$2/mg' "权威信任门移除（冗余防线，预期存活）"

# --- 入口模块变异 ---
mutate_and_run MUT4b "$ENTRY" 's/\n *assertTrustedScope\(requester\.scope\);//' "入口信任门移除（单门；权威门仍在，预期存活）"
mutate_and_run MUT5 "$ENTRY" 's/eq\(knowledgeBases\.tenantId, scope\.tenantId\),\n *//g' "KB 库租户过滤移除"
mutate_and_run MUT7 "$ENTRY" 's/throw new Error\("KB_REQUESTER_INVALID"\);/\/*mutated*\//' "请求者结构门移除"

# MUT4b-full：权威门+入口门同移（双门冗余的真实检验，预期捕获）
echo "=== MUT4b-full: 权威门+入口门同移 ==="
cp "$AUTH" /tmp/mt036-mutant-4bfull-a.tmp
cp "$ENTRY" /tmp/mt036-mutant-4bfull-e.tmp
perl -0pi -e 's/^( *)assertTrustedScope\(scope\);\n( *return kbReadTransaction)/$2/mg' "$AUTH"
perl -0pi -e 's/\n *assertTrustedScope\(requester\.scope\);//' "$ENTRY"
if diff -q "$AUTH" /tmp/mt036-mutant-4bfull-a.tmp >/dev/null || diff -q "$ENTRY" /tmp/mt036-mutant-4bfull-e.tmp >/dev/null; then
  echo "MUT4b-full NOT-APPLIED (abort)"; exit 8
fi
rm -f /tmp/mt036-mutant-4bfull-a.tmp /tmp/mt036-mutant-4bfull-e.tmp
run_focused > "$OUTDIR/MUT4b-full.log" 2>&1
fails=$(fail_count "$OUTDIR/MUT4b-full.log")
cp "$PRISTINE/kb-ownership.ts" "$AUTH"; cp "$PRISTINE/kb-restricted-query.ts" "$ENTRY"
a=$(sha256sum "$AUTH" | awk '{print $1}'); b=$(sha256sum "$PRISTINE/kb-ownership.ts" | awk '{print $1}')
c=$(sha256sum "$ENTRY" | awk '{print $1}'); d=$(sha256sum "$PRISTINE/kb-restricted-query.ts" | awk '{print $1}')
[ "$a" == "$b" ] && [ "$c" == "$d" ] || { echo "RESTORE-FAILED"; exit 9; }
echo "MUT4b-full captured_fails=$fails (restored ok)"
tail -4 "$OUTDIR/MUT4b-full.log"

# 还原后复绿
echo ""
echo "=== RESTORE green ==="
run_focused | tee "$OUTDIR/RESTORE-green.log"
