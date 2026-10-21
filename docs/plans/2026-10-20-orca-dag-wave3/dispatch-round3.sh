#!/bin/bash
set -uo pipefail
# orca-dag-wave3 R5 第三轮：mt5（C类执行侧归属）+ bf5（#268/#282/#284）+ fix1（评审 finding 修复批）
# 用户 2026-10-20 指令（细化）：中间轮不跑 OCR（独立评审保留为审查门禁）；OCR 仅在最终提交时对完整范围跑一次
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
RUN=run_dab21d1c168e
REPO=path:/Users/wuyongjun/trea/OpenBot
BASE=807844ee

dispatch() { # name worktree-selector spec
  local name=$1 wt=$2 spec=$3
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

PREFIX='通用纪律：GitHub 只读（不评论/不贴标/不关票）；不 commit 不 push；测试一律先 cd $(git rev-parse --show-toplevel)；ADR 0008 两层制（bun test ./<file> 驱动层 / bunx e2e run --config e2e.unit.config.ts 原生层，registerHooks 报错=层错配）；不改 docs/plans/ 运行目录、不改 server/src/mastra/**；完成后 worker_done 附三句摘要与 --outcome。'

MT5_SPEC="实施 MT 域 C类批次票 #90（[K] MT047 快照、shell、文件、cancel/reset/cull 的归属）与 #93（[K] MT050 Go Runtime、supervisor 与原生 agent 适配器的归属传递）（GitHub 仓库 1123786563/OpenBot；worktree 自 main@${BASE} 新建）。
背景：mt4 核验确认两票无等价实现（computer/sandbox/supervisor 仍是部署级共享 token + 用户级 actor 模型）；逐 AC 缺口与已存在的基础设施标注见 docs/plans/2026-10-20-orca-dag-wave3/workers/mt4/orca-dag-wave3-mt-r2.md（先读）。#86(MT043) 的 AC3 取消传播依赖本两票的执行侧接口——请在报告中明确写出你交付的接口形态（函数签名/取消信号路径），供 #86 后续实施对接。
Change: 每票先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文与验收；对照 ADR 0004 与 CONTEXT.md 实施：归属贯穿（快照/文件/会话/进程按 company/team 归属判定，部署级共享 token 不再隐式授权）、cancel/reset/cull 的越权语义（不可见/拒绝）、Go Runtime 与 supervisor 适配器传递归属上下文。测试落票面声明路径（以票面为准，若票面文件名不存在则以领域惯例命名并说明）。
Constraints: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5565/ 下按配方新建 openbot_enterprise_mt5（容器 orca-w3-mt-pg；fresh 库 0163 三表无 RLS/GRANT 时按测试库侧重放 MT004/MT014 语句绕过，仓库零改动；store.ts:161 MT005 门槛已知）；新迁移接续 0168。
${PREFIX}
Observable acceptance: 每票逐 AC 证据（文件+测试命令+退出码+接口形态说明）；报告写 <worktree>/reports/orca-dag-wave3-mt-r3.md 含改动文件与 sha256。"

BF5_SPEC="按序处理 Bifrost 域批次票 #268（Bifrost 07.5 真实重试重新准入）、#282（Bifrost 08.7 用户待结算原因展示）、#284（Bifrost 08.9 证据化结算与释放命令）（GitHub 仓库 1123786563/OpenBot；票名已对照运行目录 issues/ 缓存）。
前置基线：本 worktree（bf5）= main@${BASE} + 未提交前置增量（#281 recovery-alerting + 0167 + #283 recovery-items 只读路由 + admin UI 骨架；清单与哈希 docs/plans/2026-10-20-orca-dag-wave3/receipts/wave3-delta-r2/sha256.txt——注意该目录可能未随 git 提供，缺失时对开工时 git status 全量文件做 sha256 快照为基线）。前置文件视为基线不在所有权内；你的改动=快照后新增量；新迁移接续 0168。
Change: 每票先 gh api 读正文与验收；先核验基线是否已含等价实现（零改动 SATISFIED 合法），无则实施。#268 在 bifrost 子模块（pinned e44890f8；未初始化时从主 checkout .git/modules/bifrost 本地 bare clone，子模块零改动时只做核验）；#282/#284 构建在 #281 告警与 #283 recovery-items 之上（用户侧待结算原因、证据化结算/释放命令）。
Constraints: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5566/ 下新建 bf5 库（容器 orca-w3-bf-pg；roles.sql→migrate 配方）；bifrost go 测试 go.mod 1.27 缓存 toolchain 直跑（GOSUMDB off）。
${PREFIX}
Observable acceptance: 每票 SATISFIED（文件+测试+退出码）或 FAILED（原因）；报告写 <worktree>/reports/orca-dag-wave3-bf-r3.md 含你自有增量 sha256（与前置基线区分）。"

FIX1_SPEC="评审 finding 修复批（独立只读评审报告 docs/plans/2026-10-20-orca-dag-wave3/reviews/round1-review.md 的有效项；你是修复实现者）。逐项修复并各配回归测试：
- F7(Medium)#373：server/src/billing/service.ts sweepRenewals（约 :825）——sweep 路径 getSubscription 裸 id 查询改为带 customer 维度（readLiveOwnedSubscriptions 同款收窄）或对返回体与 row.externalCustomerId 交叉校验，不匹配按不可判定处理；补跨用户同字符串 id 碰撞用例（交付路径已有测试可参照）。
- F9(Info 顺带)#373：service.ts:387 entitlement reader 同款收窄。
- F1(Low)#280：docs/verification/e2e-bun-suites.json 把 server/tests/recovery-provider-query.integration.test.ts 登记入与 recovery-scan/recovery-unacked-replay 相同 group 与 files（审计生成优先：若仓库有 manifest 再生脚本则用脚本，勿手编漂移）。
- F3(Low)#381：deploy/hindsight/extensions/openbot_tenant/tenant.py:73 共享 API key 比较改 hmac.compare_digest。
- F4(Low)#381：deploy/hindsight/extensions/openbot_tenant/validator.py:118 filter_bank_list 的 allowed_bank_ids None 分支由未过滤全量改为空集（与 bank_list_scope 对齐）。
- F10(Low)#405：server/src/craft/webapp-proxy.ts sanitizeAppSetCookie（约 :356）app-only 策略下丢弃 name 等于 PREVIEW_SESSION_COOKIE 的 Set-Cookie 行，配测试。
前置基线：本 worktree（fix1）= main@${BASE} + 未提交前置增量（recovery-alerting/0167/admin UI 等；基线核对同 bf5 方式）。新迁移如需接续 0168。
Constraints: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5567/ 下新建 fix1 库（容器 orca-w3-hbc-pg；hindsight 合约测试用 deploy/hindsight/test/contract-instance.sh）。
${PREFIX}
Observable acceptance: 每 finding 一节：修复 diff 摘要+回归测试命令与退出码+对既有套件无回归证明（受影响面：billing craft hindsight 三域各跑代表性套件）；报告写 <worktree>/reports/orca-dag-wave3-fix1.md 含 sha256。"

dispatch mt5  NEW "$MT5_SPEC"
dispatch bf5  name:bf5 "$BF5_SPEC"
dispatch fix1 name:fix1 "$FIX1_SPEC"
echo "=== round3 dispatched $(date +%T) ==="
