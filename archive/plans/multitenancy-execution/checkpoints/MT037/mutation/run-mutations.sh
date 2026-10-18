#!/usr/bin/env bash
# MT037 变异测试 runner。每个变异：外科手术式替换 → 确认与 pristine 有 diff →
# 聚焦套件必须失败（捕获）→ 逐字节还原 → sha256 复验 → 还原后复绿。
# 冗余防线变异（MUT-Ca/MUT-D）预期存活，如实记录（MT036 MUT4a/b 先例）。
set -u
cd "$(dirname "$0")/../../../../../.."
SERVER=server
PRISTINE=/tmp/mt037-pristine
ENTRY=$SERVER/src/kb/application/service/kb-restricted-retrieval.ts
QUERY=$SERVER/src/kb/application/service/kb-restricted-query.ts
OUTDIR=docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT037/mutation
source /tmp/mt037-env.sh

run_focused() {
  (cd $SERVER && bun --no-env-file test tests/multitenancy/retrieval-restriction.test.ts --timeout 120000 2>&1 | grep -E "[0-9]+ (pass|fail)$|^Ran")
}

fail_count() {
  grep -E "[0-9]+ fail$" "$1" | head -1 | awk '{print $1}'
}

mutate_and_run() {
  local id="$1" target="$2" perl_expr="$3" desc="$4"
  echo "=== $id: $desc ==="
  cp "$target" "/tmp/mt037-mutant-$id.tmp"
  perl -0pi -e "$perl_expr" "$target"
  if diff -q "$target" "/tmp/mt037-mutant-$id.tmp" >/dev/null; then
    echo "MUTATION-NOT-APPLIED (aborting mutant)"; rm -f "/tmp/mt037-mutant-$id.tmp"; return 1
  fi
  rm -f "/tmp/037-mutant-$id.tmp" 2>/dev/null
  run_focused > "$OUTDIR/$id.log" 2>&1
  local fails=$(fail_count "$OUTDIR/$id.log")
  cp "$PRISTINE/$(basename "$target")" "$target"
  local now=$(sha256sum "$target" | awk '{print $1}')
  local want=$(sha256sum "$PRISTINE/$(basename "$target")" | awk '{print $1}')
  if [ "$now" != "$want" ]; then echo "RESTORE-FAILED"; exit 9; fi
  echo "$id captured_fails=$fails (restored ok)"
  tail -3 "$OUTDIR/$id.log"
  echo ""
}

# --- 主机制变异（预期全部捕获） ---
# MUT-A：候选收窄旁路——请求 kbIds 原样交给 search（隔离主机制被拆除）。
mutate_and_run MUT-A "$ENTRY" 's/const narrowed = await queryService\.narrowRetrievalScope\(\n *requester,\n *request\.kbIds,\n *\);/const narrowed = { ok: true as const, allowed: [...request.kbIds] };/' "候选收窄旁路（请求集合直进检索端）"

# MUT-B：空候选 early-return 移除（空集合仍调用检索端）。
mutate_and_run MUT-B "$ENTRY" 's/if \(allowed\.length === 0\) \{/if (false) {/' "空候选零调用移除"

# MUT-E：引用 snippet 无界（截断拆除）。
mutate_and_run MUT-E "$ENTRY" 's/snippet: runes\.slice\(0, maxRunes\)\.join\(""\),/snippet: runes.join(""),/' "citation snippet 无界"

# MUT-F：纵深防御过滤移除（预期存活——证明其非主机制地位，票注口径的诚实验证）。
mutate_and_run MUT-D "$ENTRY" 's/const results = outcome\.results\.filter\(\(row\) => candidates\.has\(row\.kbId\)\);/const results = outcome.results;/' "纵深防御过滤移除（预期存活，披露）"

# --- 信任门变异 ---
# MUT-Ca：仅入口信任门移除（narrowRetrievalScope 内部门冗余兜底，预期存活）。
mutate_and_run MUT-Ca "$ENTRY" 's/\n *assertTrustedScope\(requester\.scope\);//' "入口信任门移除（单门；预期存活）"

# MUT-C-full：入口门 + MT036 查询入口门同移（双门冗余的真实检验，预期捕获）。
echo "=== MUT-C-full: 入口门+查询入口门同移 ==="
AUTH=$SERVER/src/enterprise/tenancy/kb-ownership.ts
cp "$ENTRY" /tmp/mt037-mutant-cfull-e.tmp
cp "$QUERY" /tmp/mt037-mutant-cfull-q.tmp
cp "$AUTH" /tmp/mt037-mutant-cfull-a.tmp
perl -0pi -e 's/\n *assertTrustedScope\(requester\.scope\);//' "$ENTRY"
perl -0pi -e 's/\n *assertTrustedScope\(requester\.scope\);//' "$QUERY"
perl -0pi -e 's/^( *)assertTrustedScope\(scope\);\n( *return kbReadTransaction)/$2/mg' "$AUTH"
if diff -q "$ENTRY" /tmp/mt037-mutant-cfull-e.tmp >/dev/null || diff -q "$QUERY" /tmp/mt037-mutant-cfull-q.tmp >/dev/null || diff -q "$AUTH" /tmp/mt037-mutant-cfull-a.tmp >/dev/null; then
  echo "MUTATION-NOT-APPLIED (aborting mutant)"
else
  run_focused > "$OUTDIR/MUT-C-full.log" 2>&1
  fails=$(fail_count "$OUTDIR/MUT-C-full.log")
  echo "MUT-C-full captured_fails=$fails"
  tail -3 "$OUTDIR/MUT-C-full.log"
fi
cp "$PRISTINE/$(basename "$ENTRY")" "$ENTRY"
cp "$PRISTINE/$(basename "$QUERY")" "$QUERY"
cp "$PRISTINE/$(basename "$AUTH")" "$AUTH"
for f in "$ENTRY" "$QUERY" "$AUTH"; do
  now=$(sha256sum "$f" | awk '{print $1}')
  want=$(sha256sum "$PRISTINE/$(basename "$f")" | awk '{print $1}')
  if [ "$now" != "$want" ]; then echo "RESTORE-FAILED: $f"; exit 9; fi
done
echo "MUT-C-full restored ok"
echo ""

# --- RESTORE 复绿 ---
echo "=== RESTORE-green（pristine 复原后聚焦复绿） ==="
run_focused > "$OUTDIR/RESTORE-green.log" 2>&1
tail -4 "$OUTDIR/RESTORE-green.log"
echo "=== 终态哈希复验 ==="
sha256sum "$ENTRY" "$QUERY" "$SERVER/src/enterprise/tenancy/kb-ownership.ts"
