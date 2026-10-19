# 上游同步波次合并计划（#778 → #799）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CopilotKit/OpenBot 上游 #778→#799 共 11 个提交分 3 个波次合并进 fork 的 main。

**Architecture:** 上游 force push 重写了 8 月 16 日以来的历史，`merge-base(main, upstream/main)` 退到 f238ce97，直接 merge 会重放全部已同步内容产生大面积假冲突。因此先把新 11 提交 cherry-pick 到等价基座 `6b19a4a1`（main 内已有的 #778 旧历史对象，内容与新链 6d86ba47 等价）上建 `upstream-sync` 分支，再按波次 merge 该分支的分段点——merge commit 惯例保留，冲突面缩到真实增量。

**Tech Stack:** git merge/cherry-pick、bun、drizzle-kit、biome。

## Global Constraints

- 历史形态：merge commit（`--no-ff`），不用 rebase，**合并中绝不跑 `git stash`**（会收走 MERGE_HEAD）。
- 我方增量必须保住：billing / market / craft / workshop 路由、OpenConnector、enterprise、i18n 全套（`app/src/locales/{en,zh-CN}/*.json`）。
- 迁移撞号：上游新增迁移重编号追加到我方尾部（当前最大 **0162**），快照增量叠加到我方最后一个 snapshot，journal 从 HEAD 版重建。
- bun.lock 冲突：取我方版后 `bun install` 再生。
- routeTree.gen.ts：先取任意一侧，`vite build`（或 dev）时由 @tanstack/router-plugin 再生。
- 验证命令（ADR 0008 双层制，先读 `docs/adr/0008-test-runner-tester-army-e2e.md`）：
  - typecheck：`bun run --filter '*' typecheck`
  - 测试：`bun test`（全量 ~8602 用例 3-4 分钟，需测试库）
  - lint：`bunx biome lint`（只 gate lint）
- 测试库：5435 容器 `openbot-enterprise-test-pg`，先 `docker start`；schema 演进后删 public+drizzle schema 重建再 `enterprise-test-db.ts roles` + `drizzle-kit migrate`，重建后 `revoke create on schema public from public`。
- 回归判定基线：HEAD worktree（给 worktree 链好各子包 node_modules，否则 import error 漏计失败）。
- 主工作区当前脏（orca-run-all 产物），**全程在独立 worktree 中操作，不动主区未提交文件**。

## 上游 11 提交清单（新历史 hash，拓扑序）

| # | hash | PR | 内容 |
|---|------|----|------|
| 1 | `1bfdfdb8` | #781 | chart image.digest、extra volumes、Composio key |
| 2 | `cae4b6bd` | #782 | 启动时警告 key 调不通模型 |
| 3 | `82fc128b` | #771 | licence token 传 server、Intelligence 拒绝 memory 时启动提示 |
| 4 | `bb62c653` | #780 | sign-in 验证码在密码之后；**新增迁移 0056_sign_in_code_step.sql** |
| 5 | `6fb38c8b` | #784 | turn engine 移入 `@openbot/toolkit` + 拆分最大 server 文件（200 文件） |
| 6 | `d7cc57e7` | #789 | Computer handoff 提示、新会话无默认 Bot、Tab 直达 composer |
| 7 | `8c9ad4c8` | #790 | 公网研究 Exa/Firecrawl（与 Parallel 并列） |
| 8 | `9f58e7fd` | #794 | zizmor-action v0.7.0 |
| 9 | `1b1c80e4` | #798 | Bot 屏幕有内容才打开；会话里提供未连接 app |
| 10 | `53a656b9` | #797 | GitHub Actions 更新 |
| 11 | `12c3a694` | #799 | New Bot 向导命名框架、visibility 最后问、共享 harness 目录 |

波次划分（沿拓扑序切）：
- **W1** = 提交 1-4（#781 #782 #771 #780）：小功能 + 迁移重编号
- **W2** = 提交 5（#784）：turn engine 大重构，单独一波
- **W3** = 提交 6-11（#789..#799）：UX/研究工具/CI

---

### Task 0: 准备 worktree 与测试库

**Files:** 无代码文件（环境准备）。

- [ ] **Step 1: 调用 superpowers:using-git-worktrees 创建独立 worktree**

基于 main（295c0b89）建 worktree，分支名 `upstream-sync-20261019`。主区未提交的 orca-run-all 文件不动。

- [ ] **Step 2: worktree 内安装依赖**

```bash
cd <worktree> && bun install
```

- [ ] **Step 3: 确认测试库容器活着**

```bash
docker start openbot-enterprise-test-pg
```

预期：容器进入 running（或已 running 报错可忽略）。

---

### Task 1: 重放上游 11 提交到等价基座 → `upstream-sync` 重放分支

**Files:** 无手工编辑（纯 git 操作）。

**Interfaces:**
- Produces: 本地分支 `replay-20261019`，其上 11 个提交与上游新链内容一致，可逐段 merge。

- [ ] **Step 1: 从 6b19a4a1 建重放分支**

```bash
git checkout -b replay-20261019 6b19a4a1
```

- [ ] **Step 2: 按拓扑序重放 11 个提交**

```bash
git cherry-pick 1bfdfdb8 cae4b6bd 82fc128b bb62c653 6fb38c8b d7cc57e7 8c9ad4c8 9f58e7fd 1b1c80e4 53a656b9 12c3a694
```

预期：**零冲突**（基座 6b19a4a1 与新链 6d86ba47 内容等价，逐提交 diff 基于各自父提交）。若个别冲突：以上游侧（theirs）为准解决，这是纯上游内容的分支。

- [ ] **Step 3: 记录波次锚点 hash**

```bash
git log --oneline 6b19a4a1..replay-20261019
```

按序记录：第 4 个 = W1 锚点（#780 重放后），第 5 个 = W2 锚点（#784 重放后），第 11 个（tip）= W3 锚点。下文以 `$W1` `$W2` `$W3` 指代。

- [ ] **Step 4: 此分支不跑验证**（纯上游内容，上游 CI 已验），直接进 Task 2。

---

### Task 2: W1 波次 —— merge #781 #782 #771 #780（小功能 + 迁移重编号）

**Files:**
- Modify: `server/drizzle/0056_sign_in_code_step.sql` → 重编号为 `0163_sign_in_code_step.sql`
- Modify: `server/drizzle/meta/_journal.json`（从 HEAD 版重建，追加 0163 条目）
- Modify: `server/drizzle/meta/0162_snapshot.json` 之上的叠加（上游 0056_snapshot.json 增量叠到我方 0162 snapshot，新文件 `0163_snapshot.json`；注意上游 snapshot 表键带 `public.` 前缀）
- Modify: `app/src/locales/{en,zh-CN}/*.json`（#780 sign-in 文案新键，en 取上游，zh-CN 补译）
- Modify: `bun.lock`（冲突取我方版后再生）

**Interfaces:**
- Consumes: `$W1`（Task 1 产出的第 4 个重放提交）。

- [ ] **Step 1: 切回同步分支并 merge**

```bash
git checkout upstream-sync-20261019
git merge --no-ff $W1 -m "Merge upstream sync W1: #781 chart digest/Composio, #782 boot key warning, #771 licence token, #780 sign-in code (至 #780)"
```

- [ ] **Step 2: 解冲突（按类别）**

- `bun.lock`：`git checkout --ours bun.lock && bun install` 再生。
- `server/drizzle/0056_sign_in_code_step.sql`：`git mv` 改名 `0163_sign_in_code_step.sql`。
- drizzle meta：上游 `0056_snapshot.json` 的**增量**（相对其父 snapshot）叠到我方 `0162_snapshot.json` 生成 `0163_snapshot.json`；`_journal.json` 保留我方 HEAD 全量 + 追加 0163 条目（idx 连续）。
- locale：en 侧取上游新键；zh-CN 对照补译（sign-in 验证码相关文案）。
- 其余上游新文件直接保留。

- [ ] **Step 3: 迁移冒烟验证**

```bash
docker exec -it openbot-enterprise-test-pg psql -U postgres -d openbot_test -c 'drop schema if exists public cascade; drop schema if exists drizzle cascade;'
# 按 ADR 0008 / enterprise-test-db.ts 的 roles + migrate 流程重建
bun run --filter server drizzle-kit migrate
```

预期：0163 迁移应用成功，无 silent exit。

- [ ] **Step 4: 门禁**

```bash
bun run --filter '*' typecheck
bun test
bunx biome lint
```

预期：typecheck 0 错；bun test 与 HEAD 基线同数失败（先在 HEAD worktree 跑一轮记录基线，给 worktree 链好子包 node_modules）；biome lint 0。

- [ ] **Step 5: 完成 merge commit**

```bash
git add -A && git commit --no-edit  # 若 merge 已自动提交则跳过
```

---

### Task 3: W2 波次 —— merge #784（turn engine → toolkit，200 文件）

**Files:**
- Create: `toolkit/` 包（turn engine 新家，上游带来）
- Modify: `server/src` 大量拆分重排文件与我方 server 增量（billing/memory/hindsight/opik 等）的交界处
- Modify: `bun.lock`（toolkit 新依赖）

**Interfaces:**
- Consumes: `$W2`（Task 1 产出的第 5 个重放提交）。
- Produces: turn engine 位置变更——后续我方 server 改动如引用旧路径需改走 `@openbot/toolkit`。

- [ ] **Step 1: merge**

```bash
git merge --no-ff $W2 -m "Merge upstream sync W2: #784 turn engine 移入 @openbot/toolkit + server 大文件拆分"
```

- [ ] **Step 2: 解冲突（预期最大冲突波）**

- `bun.lock`：同 W1 配方。
- server 拆分撞我方增量：**先取上游拆分后的新文件结构**（拆分是移动+改名），再把我方在旧大文件里的增量函数/逻辑搬进拆分后的对应新文件。逐文件对照：`git diff HEAD...$W2 -- <旧大文件路径>` 看上游把哪些段挪去了哪。
- 我方独有模块（billing/memory/hindsight/opik/craft）不在上游拆分范围，冲突多为 import 路径级，跟随上游新路径修正。

- [ ] **Step 3: 安装与生成物再生**

```bash
bun install
```

routeTree 若冲突：取任意侧，build 时再生。

- [ ] **Step 4: 门禁（本波必跑全量）**

```bash
bun run --filter '*' typecheck
bun test
bunx biome lint
```

预期同 Task 2 Step 4。turn engine 相关 suite（toolkit/tests）应全绿。

- [ ] **Step 5: commit**

```bash
git commit --no-edit  # 或完成冲突标记后 add -A 再 commit
```

---

### Task 4: W3 波次 —— merge #789..#799（UX / 研究工具 / CI）

**Files:**
- Modify: `app/src/routes/bots.$agentId.*` 页面树（#798 Bot 屏开合逻辑）
- Modify: New Bot 向导（#799 框架命名、visibility 顺序）
- Modify: 研究工具注册（#790 Exa/Firecrawl）
- Modify: `.github/workflows/*`（#794 #797）
- Modify: `app/src/locales/{en,zh-CN}/*.json`（新 UI 文案键）
- Modify: `app/src/routeTree.gen.ts`（冲突取任意侧再 build 再生）

**Interfaces:**
- Consumes: `$W3` = replay-20261019 tip。

- [ ] **Step 1: merge**

```bash
git merge --no-ff $W3 -m "Merge upstream sync W3: #789 handoff/无默认Bot/Tab, #790 Exa/Firecrawl, #794 zizmor, #798 Bot screen, #797 Actions, #799 向导框架命名 (至 #799)"
```

- [ ] **Step 2: 解冲突**

- app 路由：我方 bots.$agentId.* 页面树取上游版行为改动 + 我方路由增量（craft/workshop/market）保住；上游改写的屏幕文件取上游版，i18n 重套（键从上游 en 补，zh-CN 补译）。
- `routeTree.gen.ts`：任意侧 + 再生。
- `bun.lock`：同配方。
- `.github/workflows`：上游版 + 我方自有的 workflow 文件保留。

- [ ] **Step 3: routeTree 再生**

```bash
bun run --filter app build  # 或 ADR 0008 记载的生成命令，@tanstack/router-plugin 再生 routeTree.gen.ts
git add app/src/routeTree.gen.ts
```

- [ ] **Step 4: 门禁（最终全量）**

```bash
bun run --filter '*' typecheck
bun test
bunx biome lint
```

预期：三绿或与 HEAD 基线持平；e2e（api.e2e.test.ts）需 3001 活服务，本机按 ADR 0008 决定跑不跑（Appium/移动端跳过）。agent-computer 独立包单独 `bun install` 后验证。

- [ ] **Step 5: commit**

---

### Task 5: 收尾 —— 回归对账与推送决策

**Files:** 无代码（验证与汇报）。

- [ ] **Step 1: 与 HEAD 基线对账**

全量 `bun test` 若有超出基线的失败：逐条判断"并发干扰 / DB 状态 / 真合并回归"，用 HEAD worktree 复跑定位（见 Global Constraints 基线配方）。

- [ ] **Step 2: 汇报并等待推送确认**

三个 merge commit 完成后**不自动 push**，向用户汇报波次结果与验证证据，等待确认后推 `origin/main`。

- [ ] **Step 3: 更新记忆**

同步完成后更新 `project_upstream_sync.md`：新同步点（#799 对象 hash）、force push 重放法（cherry-pick 到等价基座再 merge）、迁移新尾部编号。
