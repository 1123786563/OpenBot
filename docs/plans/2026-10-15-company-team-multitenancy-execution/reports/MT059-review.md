# MT059 独立复审报告 —— 用户私有 Bot（Issue #102）

- 复审者：独立复审 worker（Pi，Orca Task `task_433cbe31f952` / Dispatch `ctx_e8800316f1ce`）。独立会话，只读复审（唯一例外 = brief 明示的 MUT-1 同形变异注入，已字节复原并落盘证据）。
- 日期：2026-10-18。对象树：r14-mt059 工作树（HEAD=`f0520524` + 240 项转移 + 增量；前任 checkpoint 提交 `7a46db20`）。
- 输入：`briefs/MT059-review-brief.md`；实现报告 `reports/MT059.md`；证据 `checkpoints/MT059/`。
- 复审证据落盘：`checkpoints/MT059/review/`（00-provision / 10-MUT-1R-replay / 20-review-verification / MUT-1R-review-injection.diff / migration-generated）。

## Verdict：**PASS**

四任实现报告的每一条可核查声明均在本复审中独立复现成立；MUT-1 移除干净；冻结面逐字节一致；无阻断性 finding。3 条 P3 非阻断观察见下。

## 复审执行摘要（全部本会话从零实际执行）

| # | 项 | 结果 | 期望 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 三步配方 provision（r14e 命名空间，端口 55575） | 容器 `mt059-review-pg`；库 `openbot_enterprise_r14e`/`_assigned`/`openbot_kb_r14e`；KB 属主 `ent_r14e_kb`（NOSUPERUSER NOBYPASSRLS + DB OWNER + REVOKE PUBLIC）；base migrate ok；16 任务链修正序 **16/16** generate+apply；KB runMigrations ok；journal 33 步（31 前置 + MT059×2 由聚焦套件按设计自应用） | 同左 | ✓ |
| 2 | 聚焦 `openmuse-private-bot.test.ts` | **28 pass / 0 fail / 125 expect()** | 28/0/125 | ✓ 逐字一致 |
| 3 | 全量 `bun test tests/multitenancy` | **1018 pass / 0 fail，39 files，22.61s**，exit 0 | 1018/0/39 | ✓ |
| 4 | 冻结面核对 | `bots-ownership.ts`=`3bb3288b…`、`runtime-config.ts`=`0a8bc3cd…`，与 `before-hashes.txt` **及 checkpoint `7a46db20` 及 HEAD** 三方逐字节一致 | 逐字节一致 | ✓ |
| 5 | MUT-1 同形变异注入自证 | 注入后聚焦 **27 pass / 1 fail**，唯一红 = AC1「重复请求返回同一 Bot」；字节复原（sha256 `ba7ec225…` 前后一致）后复跑 **28/0/125** | 聚焦捕获、复原 | ✓ |
| 6 | typecheck/biome | 未重跑（不在 review brief 必做清单）；实现证据 `verification/41/42` 存在且全量 1018/0 通过从旁佐证 | — | 未复跑（披露） |

## 专项核对结论

### 1. MUT-1 移除干净度 —— 干净（第一专项）

- `git show 7a46db20:personal-bot.ts` 与工作树文件逐行 diff：**唯一差异** = 幂等分支内 −33/+1。checkpoint 态是活体变异（重复请求消费 `userFields` 改写 `document` + `revision+1` + `updatedAt=now()`，注释自述「验证后还原」）；工作树态还原为：

  ```ts
  const ownership = await readOwnershipRows(tx, scope);
  return allowView(existing, ownership);
  ```

  即**重复请求原样返回既有行、不推进 revision、不改写任何字段、首建输入只在首建消费**——与注释「幂等路径：三元组已有行 → 原样读回（不推进版本号、不改写任何值）」及 AC1 语义逐字相符。
- 实现存档 `mutation/MUT-1-removal.diff` 与本复审独立重算 diff 完全一致（仅 header 元数据行不同）。
- 其余 6 个 MT059 范围文件（schema/enterprise-personal-bot.ts、openmuse-private-bot.test.ts、support/personal-bot.ts、migration-tool.test.ts、migrate-test.ts、schema/index.ts）与 checkpoint **逐字节一致**；brief 唯一 +10 行 = coordinator 四任注记（授权改动）。全树 `grep MUT-` 仅命中 MT036 时代史料注释，无变异残留。
- 本复审自行注入同形变异（MUT-1R）：聚焦 27/1 唯一红 = AC1 幂等用例 → **证明该用例确实捕获此变异**（四任 RED 证据 `MUT-1-idempotency-RED.txt` 同形复现），随后 sha256 字节级复原并复跑 28/0/125。证据：`review/MUT-1R-review-injection.diff`（43 行）、`review/10-MUT-1R-replay.txt`。
- 附带结论（与四任披露一致）：**checkpoint 提交 `7a46db20` 本身不是 GREEN 态**（内含活体 MUT-1，聚焦必 27/1）；最终代码态以本工作树为准。若后续做集成分支必须携带这 34 行 diff。

### 2. AC1 三元组幂等 —— 成立

- 首建落一行：`pbot-` 服务端身份（全局唯一索引）、模板+用户字段同文档、所有权行显式清单（template×3 + user×2，`byField.size===5`）。
- 重复全同请求：agentId/revision/深冻结字段快照全同、`rawCounts.personalBots===1`；携带**不同** userFields 的重复请求同样不改写既有行（`style` 保持 `"compact"`）。
- 模板冲突：不同 templateRef = `PERSONAL_BOT_TEMPLATE_CONFLICT` 响亮拒绝且行数不变。
- 结构兜底：复合主键 `(tenant_id, workspace_id, principal_id)` 即票面幂等键，物理上至多一行；排他 personal-bot 锁内不可能并发首建。
- 且经 MUT-1 / MUT-1R 双向自证。

### 3. AC3 字段所有权 —— 成立

- 升级前后用户字段逐位不变的**对照断言**真实存在：`beforeAll` 深拷贝快照 `{style,myPrompt,sticky}` vs 升级后 `clonedSnapshot(...)` 逐字节相等，值逐项断言。
- 升级前模板字段名不可侵占用户字段：创建时 `ensurePersonalBot` 对 `key in templateDocument` 响亮 `PERSONAL_BOT_FIELD_MANAGED_BY_TEMPLATE`；写入期 `updateUserFields` 对 template 所有权行同名响亮拒绝且文档值不变。
- 升级后所有权表真实状态断言（sections 行消失、digestAt 行 template、用户行原样）直接读真实表。
- 经 MUT-2（搬运循环拔除）反向自证：用户字段快照 `{"style":…,"myPrompt":…,"sticky":…}` → `{}` 被逐位对照断言捕获（27/1）。

### 4. AC2 隔离 —— 成立

- 跨公司按 id 读 = MT011 canonical not-found **逐字节同形**：`frozenSnapshot(crossCompany) === frozenSnapshot(missingId) === canonicalNotFoundJson`（`serializeNotFoundVerdict(notFoundVerdict())` 冻结实例）。
- 同公司跨团队不可见（三元组钉住）：a1 建的 Bot 在 a2 上下文 `getPersonalBot`/`getPersonalBotById` 双路径 canonical not-found，切回 a1 原样可见——代码对应 `visibleWithFacts` 的 `row.workspaceId !== scope.workspaceId → null` 第二道独立防线（RLS 只裁租户+主体，不裁团队）；MUT-3（拔掉该防线）被 27/1 捕获。
- 同团队他人不可见（restrictive 主体自读）+ 撤权 fail-closed（suspend 后 ensure 响亮拒、读 not-found、旧 scope epoch 前进后仍拒）均有用例。

### 5. AC4 不进团队面 —— 成立

- **结构性证明（代码层）**：`personal-bot.ts` 的 import 面仅含 template installs、personal-bot 两表、tenancy、connections、not-found-semantics、scope-gate、store——**零引用** `enterprise_bot_ownership` 与团队发布注册表；两表数据通路不存在。
- **数据层**：`rawCounts.teamOwnershipRows===1`（仅对照组 MT016 团队 Bot）、`resourceRegistryRows===0`；MT016 `listBots` 含对照组、绝不含私有 Bot；`countBots total===1`；详情按私有 Bot id = canonical not-found 逐字节同形。对照组在场证明列表/计数本身工作正常，私有 Bot 缺席是结构性的。

### 6. MUT-2 披露复核 —— 披露属实

四任披露：首选变异「去掉 `applyTemplateUpgrade` 中 `!userOwnedNames.has(name)` 过滤（模板值无条件覆写）」28/0 未被捕获，因字段名不相交。本复审独立核实：

- 套件全部场景的模板名空间 v1 `{version, sections, schedule}` / v2 `{version, schedule, digestAt}` 与用户名空间 `{style, myPrompt, sticky}` **交集为空**（测试文件注释亦自述「与模板字段无名字冲突」）。
- 名字不相交时，去掉过滤后模板合并循环与所有权 upsert 集合逐项相同 → **无可观察效果，28/0 是数学必然**，披露成立。
- 更换后的变异（拔掉用户字段搬运循环）打在「用户自定义字段保留」真正机制上并被捕获——替代选择正确，字段所有权保留机制确受测试保护。

## Findings（分级）

**P0/P1/P2：无。**

- **P3-1（测试覆盖观察，非阻断）**：AC3 的「升级时新模板宣称 user 所有权字段名 → 既有 user 所有权赢」分支（`if (!userOwnedNames.has(name)) document[name] = value` 的正命中路径）没有直接正测试——套件内模板/用户名空间恒不相交，该分支从未正向执行；其防线的另一半（用户字段搬运循环）由 MUT-2 变异自证覆盖。后续如补 AC3 用例，可加一个「v3 模板宣称 style」场景把 ownership-wins 语义钉成显式断言。
- **P3-2（环境观察，非阻断）**：本工作树无 `node_modules`，复审以 `bun install --frozen-lockfile`（1415 包）补齐后测试才可运行——纯环境操作、零代码改动；后续接手者从零验证时需预算此步。
- **P3-3（证据形态，已被四任披露，复审确认）**：checkpoint 提交 `7a46db20` 含活体 MUT-1，不可直接作为 GREEN 证据引用；最终代码态 = 工作树（HEAD + MUT-1 移除，−33/+1）。集成分支须携带该 diff。

## 改动面声明（本复审）

- 生产/测试代码：**零净改动**。唯一例外 = MUT-1R 变异注入，已 sha256 字节级复原（`ba7ec225…` 前后一致）并复跑 28/0/125 验证；注入与复原 diff 存档 `checkpoints/MT059/review/`。
- 新增文件（仅复审产物）：`checkpoints/MT059/review/{00-provision.txt, 10-MUT-1R-replay.txt, 20-review-verification.txt, MUT-1R-review-injection.diff, personal-bot.pristine.ts, migration-generated/}` 与本报告。
- **零 git 提交**；`7a46db20` 未触碰。环境已清理：`docker rm -f mt059-review-pg`（回显 `mt059-review-pg`，mt059 容器清点 0）、`/tmp/mt059-review-env.sh` 已删。
