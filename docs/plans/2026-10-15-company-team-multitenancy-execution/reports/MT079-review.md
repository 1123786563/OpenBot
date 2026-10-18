# MT079 独立复审报告 —— 偏好分类：全局个人偏好 vs 范围业务配置（Issue #122）

- 复审者：独立 Pi 会话（coordinator 下发 `briefs/MT079-review-brief.md`，Orca task `task_4da727b281b8` / dispatch `ctx_a85eb53a6532`）。
- 日期：2026-10-18。被审树：worktree `i10-review-mt079`，BASE `f0520524`（与 `checkpoints/prereq-manifest.txt` 首行一致，`git rev-parse HEAD` 实测）。
- 方法：只读被审文件 + checkpoint 证据独立复算 + 独立环境全量复跑（容器 `mt079-review-pg`，pgvector/pgvector:pg16，trust+随机口令，仅回环）。唯一新建 = 本报告；未修复、未提交/推送/合并；skipped 不计为通过。
- 被审对象（3，纯新增）：`server/src/enterprise/tenancy/preferences.ts`（320 行）、`server/tests/multitenancy/preferences.test.ts`（782 行，23 用例）、`server/tests/multitenancy/support/preferences.ts`（172 行）。三文件 SHA-256 与实现者 `checkpoints/MT079/before-after-hashes.txt` 钉死值逐字节一致（`6a8f2e25…` / `c964030c…` / `93af14cc…` 实测复算）。

## 结论

**通过（PASS），附 1 个低严重度发现（F1：biome 声明不可复现）与 4 项观察。** 六项重点裁决 A–F 全部独立复核成立；Issue #122 四条验收逐条有真实测试证据；TDD 链与变异 4/4 属实；零改动核验通过（67/67 哈希一致，新增恰为 3 文件）。F1 不影响行为正确性（纯格式），但「biome exit 0」声明对最终交付字节不成立，且 checkpoint 未存档 biome 证据——按仓库「Evidence over claims」完成标准，应由实现者一行 `biome --write` 修复并补存档日志。

---

## 重点裁决逐项

### A. 分类清单封闭性 — ✅ 成立

- **全局清单 = shared 全部键（双向）**：`GLOBAL_PERSONAL_PREFERENCES` 恰含 `messageListEmphasis`（enum `agent|thread`）+ `selfHostBannerDismissed`（boolean）；测试 1 用 `sort()` 后数组全等断言双向钉死（清单多键、少键、漂移均失败），另有唯一性断言。`shared/user-preferences.ts` 实读确认 `UserPreferences` 恰两键。
- **六类别绑定属实（抽查源模块对号）**：
  - model-selection → `runtime-config`：`runtime-config.ts` 实存 `company.model.provider/credentialRef/defaultModel/allowedModels` 与 `override.model.*`（行 44–83、249–283），路径逐条真实。
  - policy → `governance-policy`：`routing-policy.ts` 实存 `company.network/capabilities/modelRouting` + `override.*`（行 131–150、308–324）。
  - credential-references → `runtime-config`：`company.credentials` / `override.credentials` 实存（行 61–67、83、110）。
  - default-resources → `botDefaults.*`、billing-plan-mapping → `company.planMapping` 同在 runtime-config 解析器逐条对号（行 285–319、237）。
  - prompts → `bot-configuration`：`profile-store.ts` 实证 Bot（coworker）配置读取 `configuration.systemPrompt`（行 259–261）——绑定标签与代码事实一致（D3 如实）。
- 测试另钉死：类别清单精确序列（六类无多无少、无重复）、存储封闭集、每类 title/paths 非空且 paths 唯一。

### B. 写入口 fail-closed — ✅ 成立

- **全有或全无**：`parseGlobalPreferencePatch` 逐键校验，任一未分类键/坏值在返回前 `throw`——部分生效结构上不可能。测试覆盖：混合补丁（1 合法 + `theme`）整补丁拒绝（`PREFERENCE_KEY_UNCLASSIFIED`）。
- **封闭值形**：enum 键仅接受精确成员字符串、boolean 键仅接受 `true/false`；`"bogus"`、`42`、`"yes"`、`1`、`null` 全部 `PREFERENCE_VALUE_INVALID`（测试逐条断言）。值形封闭 ⇒ 全局偏好文档结构上装不进对象/数组/业务负载（验收 3 实现面）。
- **零回显**：四条拒绝消息均为静态字符串，不含任何输入内容（源码级核实）；测试以 `sk-mt079-echo-canary-31337` canary 对 5 条拒绝消息钉死不回显 canary/键名。
- **业务形键装不进全局文档**：`defaultModel` / `systemPrompt` / `networkPolicy` / `runtime.model.credentialRef`（含值）在偏好入口全部 `PREFERENCE_KEY_UNCLASSIFIED`（测试断言）；`JSON.parse` 的 `__proto__` own-property 键同样进不了清单。
- 空补丁 / `null` / 数组 / 基元 → `PREFERENCE_PATCH_INVALID`（7 形态测试钉死）。

### C. 读入口分类门 — ✅ 成立

- `readGlobalPreferences` **遍历 `GLOBAL_PERSONAL_PREFERENCES` 而非存储键**（源码级核实），配合 `Object.hasOwn` 判存在：存储文档中的遗留脏键、业务形键、投毒数据、`__proto__` 陷阱结构上不可能出现在输出。`__proto__` 敌意文档测试额外断言无原型污染（`({}).polluted === undefined`）。
- 输出恒为完整 `UserPreferences`：清单内坏值/缺失落 `DEFAULT_USER_PREFERENCES`；非对象/`null`/数组输入落纯默认（6 形态测试钉死）。
- **永不合并范围业务条目**：实现只引用全局清单，代码路径不触及 `SCOPED_BUSINESS_PREFERENCES` 的任何存储（验收 4 实现面）。投毒文档（10 个业务标记 + canary）纯函数面与真实数据库面（落库后经门读回）双向零泄露，9 个标记序列化断言零出现。

### D. digest — ✅ 成立（双向锁定独立重算）

- 复审者**手工转写**两段清单规范序列化（读源码转写，不 import 模块）后 SHA-256 重算：`0f5d77abed56c850cd5cb9f8cfcfbdb0431e44ee4402b90aa58cb9da0a153ed0`——与测试钉死精确 hex **逐字符一致**（双向锁定：清单→摘要、摘要→钉死值均闭合）。
- 测试自身含：格式钉死（64 hex）、独立重算一致、精确 hex 钉死、两段缺席自证（`onlyGlobal`/`onlyScoped` 均异于全摘要）——清单可核对性的数学前提被断言覆盖。

### E. 零改动核验 + 接口冻结 — ✅ 成立（附 F2 观察）

- **67 项 prereq 逐文件复算**：`shasum -a 256 -c` 对 `checkpoints/prereq-manifest.txt` 全 67 项 **67 OK / 0 drift**；BASE 行 = 当前 HEAD。收尾复扫声明（`5-prereq-recompute-final.txt`）与之相容。
- **全树清点**：`git ls-files --others` ∪ `git diff --name-only` 对比 manifest——未被 manifest 覆盖的树内文件**恰为本票 3 个新建交付**，别无其他；manifest 列出的 untracked 文件全部在树。MT079「零既有文件改动」成立（F2 见下）。
- **路由层钉死测试真实（非摆设）**：测试从 `user-preferences-routes.ts` 源码提取 `strictObject({` 块内 4 空格缩进键，断言 `routeKeys.length > 0`（防空转）且 ⊆ 全局清单。实读路由源码：现键恰为 `messageListEmphasis` + `selfHostBannerDismissed` ⊆ 清单 ✓。遗留入口接受清单外新键（如将来路由加 `theme:`）会立即红。正则依赖 4 空格缩进属脆而响的设计（重排版会失败而非静默通过）——可接受的 canary 形态（F5）。
- **D1 同构性成立**：`grep` 全 `server/src` 无 `parseGlobalPreferencePatch`/`readGlobalPreferences` 任何生产调用方（exit 1 实测）；报告 D1 明确披露「生产装配接线归后续消费方」；与 MT015 D1（seam 交付 + 接口冻结 + 装配归消费方票 + 现状风险由既有防线覆盖）逐要素同构。现状风险面核实：遗留写入口有路由 `zod strictObject` 未知键拒绝；遗留**读**入口（`createUserPreferencesStore.read` 的裸 spread 合并）今日确实不经分类门——这正是 D1 披露并接受的残留风险，披露属实、未淡化。

### F. TDD 链 + 变异 + 披露处置 — ✅ 成立

- **TDD**：RED-1 为真（`Cannot find module …preferences`，0 pass）；GREEN-1 23/0/225 一次成绿（D4 如实披露，风险由 4/4 变异对冲）；REFACTOR 补 digest 精确 hex 钉死（225→226）。
- **变异 4/4 计数核对**（逐日志复核）：MUT1 去读过滤 17/6 ✓（毒面纯函数+DB、完整形状、非对象、`__proto__`、冻结）；MUT2 放行未分类 21/2 ✓（未分类拒绝组+混合补丁）；MUT3 摘要丢 scoped 段 22/1 ✓ 且加钉死后复核仍 22/1 ✓；MUT4 业务键混入全局清单 18/5 ✓（键集同步、值形、分类回答、digest 双断言）。每次 `Ran 23 tests`（无 skip 假跑）；pristine `6a8f2e25…` 恢复校验在案，与今日交付字节一致。
- **账目复算**：基线 577 pass / 9639 expect / 22 文件（0-baseline 实存）；600 = 577 + 23 ✓（本复审独立复跑实测 600/0/0 / 23 文件）；9865 = 9639 + 225 + 1 对实现者自身两次全量运行成立（after-green 9864 → final 9865，digest 钉死 +1）（F3 见下）。
- **D1–D6 逐条处置**：D1 已核（无调用方+MT015 同构）✓；D2（theme/language 有意不入清单，fail-closed 优先于猜测）与测试行为一致（两键均 `PREFERENCE_KEY_UNCLASSIFIED`）✓；D3（prompts 绑定）经 profile-store 源码实证 ✓；D4（一次成绿）披露属实+变异对冲 ✓；D5（容器/端口命名）属实现环境自述，无冲突 ✓；D6（expect 账目）对实现者自身运行成立，附 F3 运行间波动观察 ✓。

---

## 独立复跑记录（本复审自建环境，全部实测）

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 端口预检 | **55502 被并行复审容器 `mt076-review-pg` 占用**（启动约 1 分钟；未触碰他票容器），改用预检空闲的 **55503**（偏离 brief 字面端口，机制不变：预检空闲+仅回环） |
| 2 | 容器 | `mt079-review-pg`（pgvector/pgvector:pg16，随机口令，`127.0.0.1:55503`）；`pg_isready` accepting |
| 3 | 六变量 env | `/tmp/mt079-review/env.sh` 0600（TEST / SETUP / DIRECTORY / DATA / OPERATOR + MT003_ASSIGNED；三受限登录 `ent_mt079_review_{dir,data,oper}`），用后已删并验证不存在 |
| 4 | base migrate | `bun --no-env-file scripts/enterprise-test-db.ts migrate` → `{"type":"migrations-applied","status":"ok"}`，exit 0（schema + `ob_ent_*` 能力角色 + 三受限登录） |
| 5 | 迁移链 | MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026 九任务经 MT003 工具 `generate`→`--apply --manifest` 逐任务真实执行，journal 留痕与实现者 `prereq-apply-chain.txt` 步骤清单逐字一致（本票无迁移 ✓） |
| 6 | 聚焦套件 | `preferences.test.ts` → **23 pass / 0 fail / 0 skip（226 expect）**，exit 0；5 个数据库用例真实执行（受限角色断言通过），**无任何 skip** |
| 7 | 全量回归 | `bun --no-env-file test tests/multitenancy/ --timeout 30000` → **600 pass / 0 fail / 0 skip / 23 文件**，exit 0（600 = 577 + 23 ✓；expect 计 9868，见 F3） |
| 8 | typecheck | `cd server && bun run typecheck` → exit 0 |
| 9 | biome（3 触及文件） | **exit 1——1 处格式错**（见 F1；仓库 pinned `@biomejs/biome` 2.5.10，repo 根与 `server/` 两个工作目录均复现） |
| 10 | prereq 复算 | 67/67 OK / 0 drift（见 E） |
| 11 | 清理 | `docker rm -f mt079-review-pg` ✓（ps 复核 0 残留）；env 文件与 /tmp 中间产物删除并验证不存在 ✓ |

---

## Findings

### F1（低严重度，可复现）—「biome exit 0」声明对交付字节不成立，且无存档证据

`bunx biome check`（pinned 2.5.10）对 `server/src/enterprise/tenancy/preferences.ts` 报 1 处格式错（行 262–266：多行 `if (` 条件应为单行），repo 根与 `server/` 下均 exit **1**。交付文件 SHA-256 与实现者 pristine 钉死值**逐字节一致**——即实现者声明「首轮 4 处格式错 `--write` 后 clean」的字节状态与今日交付状态相同，该声明却不可复现；且 `checkpoints/MT079/verification/` **没有存档任何 biome 日志**（0-baseline/1-focused/2-full-suite/3-typecheck 均在，biome 缺席）。推断：`--write` 后某次编辑（如 digest 钉死 REFACTOR 或 MUT perl 还原）重新引入了多行形态，且收尾未复跑 biome。**影响**：纯格式，零行为差异；但违反仓库「Evidence over claims」完成标准。**处置建议**：实现者 `biome --write` 一行修复 → 复跑 biome + 聚焦套件 → 将 biome 日志存档 `verification/4-biome.md`。复审不修复（无授权）。

### F2（观察）—「全树零漂移」实为 manifest 范围声明

树内另有 2 个相对 BASE 的已改跟踪文件：`enterprise/runs/events.ts`（+12 行）、`enterprise/runs/runner.ts`（+4 行）——**MT007（Issue #50）的已复审交付**（diff 内注释、`reports/MT007.md` §最小接入逐行对号），不在 67 项 prereq-manifest 内。67/67 复算因此证明的是「manifest 范围零漂移」+「本票新增恰 3 文件」，而非全树逐文件零漂移。MT079 自身「未改动任何既有文件」的声明不受影响（新增 3 文件之外无任何本票指纹）。风险评级：无；记录在案供 coordinator 汇总树状态时使用。

### F3（观察）— expect() 总数存在运行间波动，账目不变式应锚定测试数而非 expect 数

三次全量运行的 expect 总数：实现者 after-green **9864**、final **9865**、本复审 **9868**（Δ3）。波动源自基线文件中运行时依赖的 expect 循环（如 `restrictedCalls()` 录得条数随执行时序变化）；MT079 自身贡献恒为 226（聚焦三次实测一致）。D6 的 9865 = 9639 + 225 + 1 对实现者自身运行成立；跨运行稳定的账目不变式是 **600 = 577 + 23（测试数）**，建议后续票以此为锚。

### F4（nit）— digest 输入不含类别 `title`

`classificationDigestFacts()` 的 scoped 段编码 `category / authoritativeStorage / documentPaths`，不含人类可读 `title`——单独改 `title` 不会改变摘要。title 无行为语义，分类事实已完整入摘要，故可接受；但模块头注「清单任何一项增删改都会改变摘要」对 title-only 编辑略有过宽表述，建议措辞收敛为「任何分类事实的增删改」。

### F5（nit，fail-closed 形脆性）— 路由键提取正则依赖 4 空格缩进

`preferences.test.ts` 的源码级路由同步测试用 `/^\s{4}([A-Za-z0-9_]+):/gm` 提取 `strictObject` 键。路由文件重排版（如缩进方案变化）会使提取为空、`routeKeys.length > 0` 断言失败——**响而不错**（fail-closed 的 canary 形态），可接受；若要降噪可改为 AST 或导出 schema 常量复用，非必需。

---

## 判定汇总

| 裁决项 | 结果 | 关键证据 |
| --- | --- | --- |
| A 分类封闭性 + 存储绑定 | ✅ | 双向键集钉死；五类绑定逐条对号源模块（runtime-config / routing-policy / profile-store） |
| B 写入口 fail-closed | ✅ | 全有或全无结构保证；封闭值形 12 形态拒绝；零回显 canary 钉死 |
| C 读入口分类门 | ✅ | 清单遍历 + `Object.hasOwn`；投毒/`__proto__` 纯函数面+DB 面零泄露 |
| D digest | ✅ | 复审者手工转写独立重算 = 钉死 hex（逐字符一致）；两段缺席自证 |
| E 零改动 + 接口冻结 | ✅（附 F2） | 67/67 哈希复算；新增恰 3 文件；路由钉死真实；D1 与 MT015 同构且披露属实 |
| F TDD + 变异 + 披露 | ✅ | RED 真 / GREEN 225→226 / 变异 4/4 逐日志核对 / D1–D6 逐条属实 |
| 独立复跑 | ✅ | base migrate + 九任务链 + 聚焦 23/0/0 + 全量 600/0/0 + typecheck exit 0 |
| biome（3 触及文件） | ❌ | **F1：exit 1，1 处格式错；声明不可复现、证据未存档** |

**总评**：MT079 的实现质量与证据纪律为同系列中的高水准（清单封闭 + digest 双向锁定 + 投毒/零回显/canary 断言 + 变异守卫均为真）；唯一需要收尾的是 F1 的 biome 修复与证据补档，不构成对四条验收或分类语义的任何质疑。复审环境备注：brief 指定端口 55502 被并行复审容器占用，本复审经预检改用 55503，隔离与安全机制（仅回环、随机口令、0600 env、用后清理）全部照常执行。
