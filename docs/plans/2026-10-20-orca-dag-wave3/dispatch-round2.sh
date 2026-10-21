#!/bin/bash
set -uo pipefail
# orca-dag-wave3 R5 第二轮：mt4（新 worktree）+ bf4/hbc4（预置前置增量）+ 独立评审者
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
RUN=run_dab21d1c168e
REPO=path:/Users/wuyongjun/trea/OpenBot
BASE=3b4a7c68   # main@2026-10-20 13:56（用户已提交 wave2 集成与 wave3 计划文档）

dispatch() { # name worktree-selector extra-flags spec
  local name=$1 wt=$2 spec=$3; shift 3
  echo "=== dispatch $name $(date +%T) ==="
  if [ "$wt" = "NEW" ]; then
    $ORCA orchestration worker-start --run "$RUN" --worktree new-child --name "$name" \
      --repo "$REPO" --base-branch main --agent claude --task-title "wave3/$name" --spec "$spec" --json \
      > "receipts/$name.json" 2>&1
  else
    $ORCA orchestration worker-start --run "$RUN" --worktree "$wt" \
      --agent claude --task-title "wave3/$name" --spec "$spec" --json \
      > "receipts/$name.json" 2>&1
  fi
  echo "exit=$? $(python3 -c "import json;d=json.load(open('receipts/$name.json'));r=d.get('result',{});print(r.get('taskId'),r.get('dispatchId'),r.get('state'))" 2>/dev/null || head -c 200 receipts/$name.json)"
}

COMMON_PREFIX='通用纪律（orca-dag-wave3 第二轮）：GitHub 仓库 1123786563/OpenBot 对 worker 只读（不评论/不贴标/不关票）；不 commit 不 push；测试命令一律先 cd $(git rev-parse --show-toplevel) 从仓库根解析路径；遵守 ADR 0008 两层测试制（bun test ./<file> 驱动层；bunx e2e run --config e2e.unit.config.ts 原生层，registerHooks 报错即层错配）；不改 docs/plans/ 运行目录、不改 server/src/mastra/**；完成后 worker_done 附三句执行摘要并明确 --outcome。'

MT4_SPEC="按序核验 MT 域批次票 #89、#90、#91、#92、#93（GitHub 仓库 1123786563/OpenBot；本 worktree 自 main@${BASE} 新建，含 wave2 集成提交；零改动判定一律引用 ${BASE}）。
Target: MT 线残余票核验（对照 docs/adr/0004 与 CONTEXT.md；server/src/enterprise、server/tests/multitenancy/ 一带，以票面为准）。注意 #90(MT047)/#93(MT050) 是执行侧接口票，#86(MT043) 的 AC3 等它们落地，核验结论请写明接口形态供后续 #86 实施使用。
Change: B类核验优先——每票先 gh api 读正文与验收，核验 ${BASE} 是否已含等价实现；确认满足给 SATISFIED 证据（文件定位+测试命令+退出码），无等价实现给 FAILED（逐 AC 缺口+file:line），不赶工实施。
Constraints: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5565/ 下按仓库配方新建 openbot_enterprise_mt4 测试库（容器 orca-w3-mt-pg，pgvector pg16；enterprise 库 roles.sql→migrate 顺序配方；已知坑：fresh 库上 0163 恢复表与 MT 任务链 create 步冲突时，按测试库侧重放 MT004/MT014 RLS+GRANT 绕过，仓库零改动）。
$COMMON_PREFIX
Observable acceptance: 每票 SATISFIED/FAILED + 证据；报告写 <worktree>/reports/orca-dag-wave3-mt-r2.md（含改动 sha256，预期零改动）。"

BF4_SPEC="按序实施 Bifrost 域批次票 #266、#267、#281、#283（GitHub 仓库 1123786563/OpenBot）。
Target: B07.3 未预留 short-circuit 拒绝语义（#266）、B07.4 dispatch 承诺持久化与幂等 claim（#267）、B08.3 ledger 已结算但 ack 丢失的重放（#281）、B08.6 持续异常告警（#283）。
前置基线：本 worktree（bf4）= main@${BASE} + 已应用的前置增量（前置票 #265/#274/#280 已实施并集成：credit-reservations schema、billing/recovery-provider-query.ts + 0165 迁移、journal 已含 0164-0166）。开工先 git status 快照并核对 receipts 前置清单（运行目录 docs/plans/2026-10-20-orca-dag-wave3/receipts/wave3-delta-r1/ 的 sha256.txt）；前置文件视为基线，不在你的所有权内、不要修改；你的改动=快照之后的新增量。新迁移接续 0167。
Change: 每票先 gh api 读正文与验收，先核验基线是否已含等价实现（零改动 SATISFIED 合法）；无等价实现才实施。
Constraints: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/ 下新建 bf4 测试库（容器 orca-w3-bf-pg，pgvector pg16）；bifrost go 测试 go.mod 1.27、缓存 toolchain 直跑（GOSUMDB 坑）。
$COMMON_PREFIX
Observable acceptance: 每票 SATISFIED（证据：文件+测试命令+退出码）或 FAILED（原因）；报告写 <worktree>/reports/orca-dag-wave3-bf-r2.md，含逐票结论、你自有增量的改动文件与 sha256（与前置基线区分）。"

HBC4_SPEC="按序处理混合域批次票 #382、#425（GitHub 仓库 1123786563/OpenBot）。
Target: Hindsight 05 通用个人偏好的跨 Bot 语义召回（#382）；Craft 预览 Origin 修复 R06 legacy 同源预览加开关与风险可见性（#425）。
前置基线：本 worktree（hbc4）= main@${BASE} + 已应用前置增量（#381 bank-scope.ts + hindsight/extensions + #405 cookie 策略 + #411 TLS 门禁 preview-tls-status.ts + #373 billing 续期 + journal 0164-0166 已在）。开工先 git status 快照并对照 docs/plans/2026-10-20-orca-dag-wave3/receipts/wave3-delta-r1/sha256.txt；前置文件不在你的所有权内；你的改动=快照后新增量。新迁移接续 0167。
Change: 每票先 gh api 读正文与验收；#382 应复用 #381 的 resolveHindsightBankScope 派生隔离（勿另造身份 seam）；#425 对照 #358 修复计划 R06 条目（legacy 同源挂载加显式开关与风险可见性，AC1 例外收口）。先核验是否已有等价实现，无则实施。
Constraints: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5567/ 下新建 hbc4 测试库（容器 orca-w3-hbc-pg）；hindsight 合约测试用 deploy/hindsight/test/contract-instance.sh（一次性真实实例）。
$COMMON_PREFIX
Observable acceptance: 每票 SATISFIED/FAILED + 证据；报告写 <worktree>/reports/orca-dag-wave3-hbc-r2.md，含你自有增量与 sha256。"

REVIEW1_SPEC="对主工作区 /Users/wuyongjun/trea/OpenBot 的未提交 wave3 集成增量做独立只读评审（你是独立评审者，与实现者不同会话）。
范围：git diff HEAD（tracked，21 文件）+ 未跟踪新文件（server/src/billing/recovery-provider-query.ts、server/src/hindsight/bank-scope.ts、server/src/craft/preview-tls-status.ts、deploy/hindsight/extensions/**、三个测试文件、server/drizzle/0165_/0166_ 迁移；完整清单 docs/plans/2026-10-20-orca-dag-wave3/receipts/wave3-delta-r1/）。
评审对象票：#280（B08.5 provider 终态查询）、#381（Hindsight 04 bank 隔离）、#373（BP05 续期幂等）、#405（preview 代理 cookie 策略）、#411（TLS renewal-status 门禁）。每票两个结论：Spec compliance（对照票面验收逐条 MET/NOT/PARTIAL）与 code quality（correctness/安全/测试充分性）。
已知事实（勿重复报告）：main-ws 本地 .env 的 PORT/SERVER_PORT 冲突会干扰默认 admission 路径的测试（评审时以隔离环境 A/B 为准，wave2 已记录同类）；typecheck 3 个 bootstrap-local-gateway 基线错误先于本增量存在。
纪律：只读——除 docs/plans/2026-10-20-orca-dag-wave3/reviews/round1-review.md 外不得写任何文件、不得改代码、GitHub 只读。有效 finding 按严重度分级并给 file:line。
Observable acceptance: reviews/round1-review.md 含逐票双结论、finding 清单与裁决建议；worker_done 附三句摘要与 --outcome。"

dispatch mt4  NEW "$MT4_SPEC"
dispatch bf4  name:bf4 "$BF4_SPEC"
dispatch hbc4 name:hbc4 "$HBC4_SPEC"
dispatch reviewer1 path:/Users/wuyongjun/trea/OpenBot "$REVIEW1_SPEC"
echo "=== round2 dispatched $(date +%T) ==="
