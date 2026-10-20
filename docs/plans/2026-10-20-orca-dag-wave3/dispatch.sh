#!/bin/bash
set -uo pipefail
# orca-dag-wave3 R5 首批派发：3 流 × 1 worker（用户 2026-10-20 授权：171 张全量、3 流）
# 票号从 scope.json/dag.json 机械导出（jq 包含性断言见 dispatch 前检查）
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
RUN=run_dab21d1c168e
REPO=path:/Users/wuyongjun/trea/OpenBot

dispatch() { # name spec
  local name=$1 spec=$2
  echo "=== dispatch $name $(date +%T) ==="
  $ORCA orchestration worker-start \
    --run "$RUN" \
    --worktree new-child --name "$name" \
    --repo "$REPO" \
    --base-branch main \
    --agent claude \
    --task-title "wave3/$name" \
    --spec "$spec" \
    --json > "receipts/$name.json" 2>&1
  local rc=$?
  echo "exit=$rc $(python3 -c "import json;d=json.load(open('receipts/$name.json'));r=d.get('result',{});print(r.get('taskId'),r.get('dispatchId'),r.get('state'))" 2>/dev/null || head -c 200 receipts/$name.json)"
}

# 机械导出断言：首批票号必须全部在 scope.json ready 内
python3 - <<'EOF'
import json, sys
scope = json.load(open('scope.json'))
ready = set(scope['ready'])
first = [49, 56, 86, 87, 88] + [222, 263, 265, 274, 280] + [378, 381, 373, 405, 411]
missing = [n for n in first if n not in ready]
sys.exit(f"OUT OF SCOPE: {missing}" if missing else 0)
EOF
[ $? -ne 0 ] && { echo "scope assertion failed, abort"; exit 1; }

MT_SPEC='按序处理 OpenBot 多租户 MT 域批次票 #49、#56、#86、#87、#88（GitHub 仓库 1123786563/OpenBot；本 worktree 从 main@2306caaa 新建；完整后续队列见运行目录 docs/plans/2026-10-20-orca-dag-wave3/scope.json 的 domain_ready.mt，共 76 张，本批为首 5 张）。
Target: 多租户整改 MT 线残余票（分组 A–T，对照 docs/adr/0004-company-team-tenancy.md 与 CONTEXT.md；实现主要在 server/src/enterprise、server/tests/multitenancy/ 一带，以各票正文声明为准）。
Change: B类核验优先——每张票先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文与验收，再核验当前 main 是否已含等价实现（MT 线多轮交付后零改动 SATISFIED 预期为常态）；确认满足则给 SATISFIED 证据收尾，无等价实现才实施修复与测试（C类）。
Constraints: GitHub 只读（不评论/不贴标/不关票）；不 commit 不 push；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5565/mt3（容器 orca-w3-mt-pg，pgvector pg16，按仓库测试配方初始化，enterprise 库注意 roles.sql→migrate 顺序配方）；测试命令一律先 cd $(git rev-parse --show-toplevel) 从仓库根解析路径；遵守 ADR 0008 两层测试制（bun test ./<file> 与 E2E_UNIT_SCOPE=scripts bun run test）。
Ownership: 仅限各票面声明文件与对应测试；不改 docs/plans/ 运行目录、不改 server/src/mastra/**（在途另一运行所有）、不动计费及无关模块。
Observable acceptance: 每票给出 SATISFIED（核验证据：文件定位+测试命令+退出码）或 FAILED（原因/阻塞）；报告写入 <worktree>/reports/orca-dag-wave3-mt.md，含逐票结论与改动文件 sha256；完成后 worker_done 附三句执行摘要并明确 --outcome。'

BF_SPEC='按序处理 OpenBot Bifrost 域批次票 #222、#263、#265、#274、#280（GitHub 仓库 1123786563/OpenBot；本 worktree 从 main@2306caaa 新建；后续由协调器按依赖链补位——#265 完成解锁 #266/#267，#280 完成 #281/#283，全链见 docs/plans/2026-10-20-orca-dag-wave3/dag.json）。
Target: Bifrost 严格积分计费残余票：#222 B02.8 管理员发放到指定个人账户、#263 B06.12 预留/待结算/实扣用户视图、#265 B07.2 PreLLM 认证并申请预留、#274 B07.11 计费失败/取消/无 usage 处理、#280 B08.5 provider 终态查询。
Change: 每张票先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文与验收；先核验 main 是否已含等价实现（Bifrost 线已多轮交付，零改动 SATISFIED 合法）；无等价实现才实施（计价维度/预留/结算链路，server/src/billing、bifrost 网关一带）。
Constraints: GitHub 只读；不 commit 不 push；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/bf3（容器 orca-w3-bf-pg，pgvector pg16）；测试命令一律先 cd $(git rev-parse --show-toplevel)；bifrost go 测试注意 go.mod 1.27、用缓存 toolchain 二进制直跑（GOSUMDB 坑）。
Ownership: 仅限各票相关 bifrost/计费链路文件与测试；不改 docs/plans/ 运行目录、不改 server/src/mastra/**、不动多租户无关模块。
Observable acceptance: 每票 SATISFIED（证据：文件+测试命令+退出码）或 FAILED（原因）；报告写入 <worktree>/reports/orca-dag-wave3-bf.md，含逐票结论与改动 sha256；完成后 worker_done 附三句执行摘要并明确 --outcome。'

HBC_SPEC='按序处理 OpenBot 混合域批次票 #378、#381、#373、#405、#411（GitHub 仓库 1123786563/OpenBot；本 worktree 从 main@2306caaa 新建；hs 链后续由协调器补位，见 docs/plans/2026-10-20-orca-dag-wave3/dag.json）。
Target: Hindsight 个人记忆 #378（02 敏感候选与过期清理）、#381（04 租户身份与 Hindsight bank 隔离）；计费支付 #373（BP05 公司订阅续期与周期纠错）；Craft 预览 #405（P1 preview 代理转发应用 cookie 并安全处理 Set-Cookie）、#411（P0 CSP 增加 form-action、收紧 connect-src）。
Change: 每张票先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文与验收；先核验 main 是否已含等价实现——零改动 SATISFIED 合法；无等价实现才实施。#378/#381 对照 docs/plans/2026-10-15-hindsight-personal-memory/ 的 Spec 与既有 Wave1 交付（#377/#380/#398 已贴标）；#405/#411 对照 #358 修复计划已交付票的收口方式。
Constraints: GitHub 只读；不 commit 不 push；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5567/hbc3（容器 orca-w3-hbc-pg，pgvector pg16）；测试命令一律先 cd $(git rev-parse --show-toplevel)；ADR 0008 两层测试制。
Ownership: 仅限各票面声明文件与对应测试（memory/hindsight、billing/payments、craft proxy/CSP 各自范围）；不改 docs/plans/ 运行目录、不改 server/src/mastra/**、不动 Bifrost 计价维度票（另一流所有）。
Observable acceptance: 每票 SATISFIED（证据：文件+测试命令+退出码）或 FAILED（原因）；报告写入 <worktree>/reports/orca-dag-wave3-hbc.md，含逐票结论与改动 sha256；完成后 worker_done 附三句执行摘要并明确 --outcome。'

dispatch mt3 "$MT_SPEC"
dispatch bf3 "$BF_SPEC"
dispatch hbc3 "$HBC_SPEC"
echo "=== all dispatched $(date +%T) ==="
