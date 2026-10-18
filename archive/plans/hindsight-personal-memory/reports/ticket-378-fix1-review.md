# Ticket #378 fix1 — 审阅修正批次 · 独立只读复审

- **复审人**: 独立只读 Review Agent（Orca 分派，task_04ba5e3a273d）
- **复审对象**: `/Users/wuyongjun/orca/workspaces/OpenBot/hs01-candidate-review` 工作区（HEAD `f0520524` + 未提交 11 文件），对照审阅基线 `reports/ticket-378-review.md`（其 §3/sha 基线即 `reports/ticket-378.md` §3 表）与 fix1 附录新 sha256 表
- **方法**: sha256 全表逐文件核对 + 当前 git diff 与报告 §5 记录基线 diff 逐 hunk 对照（diff-of-diffs）+ 新增代码逐行读 + 亲自复跑全套测试与类型检查
- **纪律**: 只读，未修改被审仓库任何文件，未 commit / push
- **结论**: **变化恰好为 fix1 的 4 项，无任何多余改动 · Spec 合规 PASS · 代码质量 PASS**。F-M1 / F-L1 / F-L2 / F-L3 全部真正解决。

## 1. 变化清单（相对审阅基线）

### 1.1 检查点完整性（sha256 全表核对）：一致

当前工作区 11 个文件（8 M + 3 untracked，`git status` 无多余项）与 fix1 附录 sha256 表**逐字节一致**；其中 7 个未改动文件与 §3 基线表逐字节一致：

| 文件 | 当前 sha256 | vs 基线 |
|---|---|---|
| `server/tests/memory-store.integration.test.ts` | `9a369e8e…9403e` | 一致（未动） |
| `server/tests/memory-runtime.test.ts` | `eb4b78f4…b9abc` | 一致（未动） |
| `server/tests/memory-defaults.integration.test.ts` | `dd2d21c4…f765` | 一致（未动） |
| `server/tests/proactive-store.integration.test.ts` | `4d17689b…6fdc` | 一致（未动） |
| `server/src/memory/tools.ts` | `93fa491b…8ac93f` | 一致（未动） |
| `server/src/index.ts` | `ceb5e581…66a42` | 一致（未动） |
| `server/tests/memory-expiry.test.ts` | `f1fc63c9…ae98` | 一致（未动） |
| `server/src/memory/sensitivity.ts` | `1e779ffc…fc7d` | **fix1 改动**（原 `425d7da4…`） |
| `server/src/memory/store.ts` | `809ebf7c…b44d` | **fix1 改动**（原 `142b8d05…`） |
| `server/src/memory/ingestion.ts` | `0d13d16a…9687` | **fix1 改动**（原 `f8ba4fc3…`） |
| `server/tests/memory-sensitivity.test.ts` | `717b190d…7603` | **fix1 改动**（原 `b28c8b93…`） |

变化恰为 4 个授权文件，与 fix1 附录声明一致。

### 1.2 diff-of-diffs（当前 diff − 基线 §5 diff）逐文件

- **`store.ts`**：除 `update()` 两处 hunk 外，其余全部 hunk（imports、`CANDIDATE_TTL_MS`、`eligibleRows` inArray、`create()`、`formMemory()`、`expireStaleCandidates`、`completeSync`）与 §5 记录逐字节相同。新增/变化仅在 `update()`：
  1. 凭据检查从内联 `patch.content && classify(…) === "credential"` 改为先算 `sensitivity`（`patch.content` 为空时 `"normal"`），`credential` 仍抛 `MemoryRefusedError`，且位于 Intelligence-only 分支**之前**（两分支都盖住，行为不回退）；
  2. 本地行 `reviewState` 由无条件的 `"edited"` 改为 `sensitivity === "normal" ? "edited" : "unreviewed"` —— **即 F-M1**。
- **`ingestion.ts`**：除 import hunk 与 §5 相同外，sync 过滤处由内联 `.filter(...)` 改为 `kept` 变量 + `droppedSensitive = records.length - kept.length`，>0 时 `log.info`（`type: "memory-sync-sensitive-dropped"`，`context: { sourceId, droppedSensitive }`），`completeSync(ownerUserId, id, kept)`、`imported: kept.length` —— **即 F-L3**。`log` 为文件内既有 `getLogger("server")` 实例，作用域正确。
- **`sensitivity.ts` / `memory-sensitivity.test.ts`**（未跟踪文件，无 git diff，按 fix1 附录声明逐项核对内容，见 §2）。
- **其余 7 文件**：sha256 与基线逐字节一致，零改动。

## 2. Findings 逐项核验

### F-M1（medium）— `update()` 敏感类目编辑回落 `unreviewed`：已解决 ✓

- 实现：本地行 `patch.content` 分类为 medical/financial/customer-data 时 `reviewState` 置 `"unreviewed"`（store.ts update 本地分支），敏感编辑即退出召回门槛（`eligibleRows` 只认 `confirmed/edited`）与 Intelligence 镜像（`mirrorEligible`）；确认走既有 `update({reviewState:"confirmed"})`，无新入口。credential 拒绝不变且仍在 Intelligence-only 分支之前；Intelligence-only 行无 reviewState，按附录声明不在 F-M1 范围（与 #377 "Intelligence 行不过审核门槛" 语义一致）。普通编辑仍 `edited`。
- 测试：`an edit into sensitive content returns the memory to review (fix1 F-M1)` —— confirmed 记忆编辑成医疗内容 → `reviewState === "unreviewed"`、`retrieve` 立即不可见 → 本人 `update({reviewState:"confirmed"})` → `retrieve` 可见；普通编辑仍 `edited`。断言链完整覆盖任务要求的"编辑→立即不可召回→本人确认→可召回"。
- expiry 交互正确：回落 `unreviewed` 的行重新落入 30 天候选窗口，与"未处理候选满 30 天清除"验收一致。

### F-L1（low）— 凭据高频形状补充：已解决 ✓

`sensitivity.ts` 新增 4 组模式，全部要求"形状而非裸词"：
- `pwd` / `pass code`：`/\bpwd\b\s*(?:[=:]\s*|\bis\s+)\S+/i` 与 pass ?code 同构——必须携带值（`pwd=hunter2`、"the passcode is 482113"），裸词（shell 命令、"our pwd policy"、"passcode entry screen"）不命中；
- `ssh key`：`/\bssh[ _-]?keys?\b/i`（"ssh into the staging box" 不命中）；
- `.pem` 文件引用：`/\b[a-z0-9][a-z0-9._-]*\.pem\b/i`（`server.pem` 命中，PEM 缩写裸词不命中）；
- 带凭据 connection string：`/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i`——必须含 `user:password@`；`postgres://db.example.com:5432/app`、`redis://cache.internal:6379/0` 不命中。
- 测试正/反例各 7 条并入分类测试（正：pwd=hunter2、pwd is、passcode is、ssh key、server.pem、postgres://、mongodb+srv://；反：pwd 政策、pwd 命令、passcode 屏幕、ssh 裸词、PEM 缩写、redis 无凭据、postgres 无凭据），与附录声明一致。

### F-L2（low）— bearer 模式收窄：已解决 ✓

token 段加 lookahead `(?=[a-z0-9._~+/=-]*[0-9._~+/=-])`，要求至少一个数字或符号：`Bearer authentication is used by the API` → `normal`（复审亲自断言通过）；`Authorization: Bearer eyJhbGciOiJIUzI1NiJ9` → `credential`。原 "Bearer token … rotated" 用例改由 `tokens?` 裸词模式命中，宁误拒语义不回退。

### F-L3（low）— sync 丢弃计数日志：已解决 ✓

`droppedSensitive = 全量 − 保留`，>0 时 `log.info`，载荷仅 `sourceId` 与条数，**无任何内容**；`imported` 语义不变（实际保留数）。复审亲自复跑 sensitivity 测试实测日志行：`{"type":"memory-sync-sensitive-dropped","context":{"sourceId":"aaac34c8-…","droppedSensitive":4},…}`，与附录记载一致。

### F-I1…F-I5（info）— 无需行动，fix1 未触碰相关代码，与基线一致 ✓

## 3. 复审人亲自复跑证据（2026-10-15，本 worktree，容器 `openbot-hs01-378-pg` @127.0.0.1:5573 运行中）

```
$ cd server && TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test' \
  bun test ./tests/memory-sensitivity.test.ts ./tests/memory-expiry.test.ts ./tests/memory-store.integration.test.ts \
  ./tests/memory-runtime.test.ts ./tests/memory.test.ts ./tests/memory-intelligence.integration.test.ts \
  ./tests/memory-shared-source.test.ts ./tests/memory-defaults.integration.test.ts \
  ./tests/memory-default-source-tool.test.ts ./tests/proactive-store.integration.test.ts \
  ./tests/intelligence-memory.test.ts ./tests/bot-lifecycle.integration.test.ts
→ 103 pass, 0 fail, 403 expect() calls, Ran 103 tests across 12 files   [与 fix1 附录一致：原 102 + F-M1 新测试 1]

$ bunx tsc --noEmit        → exit 0
$ bunx biome check src/memory/sensitivity.ts tests/memory-sensitivity.test.ts
→ Checked 2 files in 125ms. No fixes applied.（0 问题）
```

## 4. 最终判定

- **变化范围核验：PASS** —— 相对审阅基线的变化恰好为 fix1 声明的 4 个授权文件、4 项 finding 修正，无任何夹带改动；7 个未授权文件逐字节未动。
- **Spec 合规：PASS** —— F-M1 使 update 编辑路径与 create() 不变量对齐（敏感类目回落 unreviewed、需本人再确认），补上 ADR 0005 严格读下唯一的边界缺口；F-L3 计数日志不改变 `imported` 语义、不含内容，无日志泄露风险。
- **代码质量：PASS** —— 实现最小且风格与基线一致（注释解释"为什么"）；新凭据模式均按"携带值/形状"收窄，避免新的误拒面；测试断言到位（F-M1 走完整"编辑→不可见→确认→可见"链，F-L1 正反例 7/7，F-L2 正反两向）。复审未发现新问题。
