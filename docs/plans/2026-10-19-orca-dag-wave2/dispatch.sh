#!/bin/bash
set -uo pipefail
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
REPO=1123786563/OpenBot

dispatch() { # name spec
  local name=$1 spec=$2
  echo "=== dispatch $name $(date +%T) ==="
  $ORCA orchestration worker-start \
    --run run_b7d44d543855 \
    --worktree new-child --name "$name" \
    --repo path:/Users/wuyongjun/trea/OpenBot \
    --base-branch main \
    --agent claude \
    --task-title "wave2/$name" \
    --spec "$spec" \
    --json > "receipts/$name.json" 2>&1
  local rc=$?
  echo "exit=$rc $(python3 -c "import json;d=json.load(open('receipts/$name.json'));r=d.get('result',{});print(r.get('taskId'),r.get('dispatchId'),r.get('state'))" 2>/dev/null || head -c 200 receipts/$name.json)"
}

CRAFT_SPEC='按序处理 OpenBot Craft 域批次票 #437、#433、#408（GitHub 仓库 1123786563/OpenBot；本 worktree 从 main@c80927fa 新建）。
Target: Craft 预览 Origin 相关实现、测试（server/src/craft/、app/、agent-sandbox/ 一带，以各票正文声明为准）。
Change: 每张票先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文与验收标准，再核验当前 main 是否已含等价实现——零改动 SATISFIED 是合法收尾（上一轮 5 张中 3 张为零改动）；无等价实现才实施修复与测试。
Constraints: GitHub 只读（不评论/不贴标/不关票）；不 commit 不 push；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5564/craft2（容器 orca-w2-craft-pg，pgvector pg16，按仓库测试配方初始化）；测试命令一律先 cd $(git rev-parse --show-toplevel) 从仓库根解析路径；#436 的 38 表迁移链修复已并入 main，fresh schema 断言以当前 main 为准；遵守 ADR 0008 两层测试制。
Ownership: 仅限各票面声明文件与对应测试；不改 docs/plans/ 运行目录、计费及无关模块。
Observable acceptance: 每票给出 SATISFIED（核验证据：文件定位+测试命令+退出码）或 FAILED（原因/阻塞）；报告写入 <worktree>/reports/orca-dag-wave2-craft.md，含逐票结论与改动文件 sha256；完成后 worker_done 附三句执行摘要并明确 --outcome。'

BF_SPEC='按序处理 OpenBot Bifrost 域批次票 #251、#287（GitHub 仓库 1123786563/OpenBot；本 worktree 从 main@c80927fa 新建）。
Target: Bifrost 05.10（#251 用户侧 Key 状态展示与全版本撤销）与 09.2（#287 公司 payer 贯穿全链路）。
Change: 每张票先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文与验收；票面无 Verification 段的按语义找等价测试；先核验 main 是否已含等价实现——零改动 SATISFIED 是合法收尾（Bifrost 线已多轮交付）；无等价实现才实施。
Constraints: GitHub 只读；不 commit 不 push；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf2（容器 orca-w2-bf-pg，pgvector pg16）；测试命令一律先 cd $(git rev-parse --show-toplevel)；bifrost go 测试注意 go.mod 要 1.27、用缓存 toolchain 二进制直跑（GOSUMDB 坑）。
Ownership: 仅限各票相关 bifrost/计费链路文件与测试；不改 docs/plans/ 运行目录及无关模块。
Observable acceptance: 每票 SATISFIED（证据：文件+测试命令+退出码）或 FAILED（原因）；报告写入 <worktree>/reports/orca-dag-wave2-bf.md，含逐票结论与改动 sha256；完成后 worker_done 附三句执行摘要并明确 --outcome。'

MT_SPEC='按序处理 OpenBot 多租户 MT 域 14 张票：#62、#63、#66、#67、#68、#75、#76、#78、#82、#83、#111、#121、#143、#167（GitHub 仓库 1123786563/OpenBot；本 worktree 从 main@c80927fa 新建）。
Target: server/tests/multitenancy/ 及对应实现（MT 线，ADR-0004 风格验收，对照 docs/adr/0004-company-team-tenancy.md 与 CONTEXT.md）。
Change: #62 MT019 特殊路径——先 git fetch 并 checkout 远程分支 1123786563/mt-w1 @ b7832879 核验已有实现（bot-lifecycle.test.ts +841 行等 4 文件），跑测试对照 #62 验收出结论，不重实施；其余 13 张每张先 gh api repos/1123786563/OpenBot/issues/<票号> 读正文，核验 main 是否已含等价实现（MT 线 106 张 A 类已批量验收，零改动 SATISFIED 预期主流），无等价实现才实施。
Constraints: GitHub 只读；不 commit 不 push；TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5562/mt2（容器 orca-w2-mt-pg，pgvector pg16；enterprise 库注意 roles.sql→migrate 顺序配方）；测试命令一律先 cd $(git rev-parse --show-toplevel)；ADR 0008 两层测试制（bun test ./<file> 与 E2E_UNIT_SCOPE）。
Ownership: 仅限各票相关 server/ 文件与测试；不改 docs/plans/ 运行目录及无关模块。
Observable acceptance: 每票 SATISFIED（证据：文件+测试命令+退出码；#62 附分支核验结论）或 FAILED（原因）；报告写入 <worktree>/reports/orca-dag-wave2-mt.md，含逐票结论与改动 sha256；完成后 worker_done 附三句执行摘要并明确 --outcome。'

dispatch craft2 "$CRAFT_SPEC"
dispatch bf2 "$BF_SPEC"
dispatch mt2 "$MT_SPEC"
echo "=== all dispatched $(date +%T) ==="
