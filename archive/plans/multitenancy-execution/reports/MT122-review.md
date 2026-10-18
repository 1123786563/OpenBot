# MT122 独立复审报告 — 部署主入口请求上下文 + 作用域工厂（Issue #165）

**Verdict：PASS**（分级 findings 见 §6：1 项 low、3 项 info；无一否定验收或证据真实性）

- 复审对象：`server/src/enterprise/tenancy/entry-context.ts`、`server/src/app.ts`（M）、`server/src/index.ts`（M）、`server/tests/multitenancy/entry-context.test.ts`、`server/tests/multitenancy/support/entry-context.ts`（增量 5 文件，全树 grep 证实 MT122 交付符号只存在于这 5 个文件，无 app/ 侧引用）。
- 复审方式：**只读复审** + brief 明示的变异重放；全部哈希、测试、探针为复审者亲手重算/重跑，非转抄实现者存档。禁 commit 遵守（HEAD 始终为 f0520524，无本地提交；树内文件集与复审开始时逐项一致）。
- 实现报告：`reports/MT122.md`（第 4 任终态）；证据：`checkpoints/MT122/`。

## 1. 环境从零 provision（复审者独立环境，非实现者环境复用）

- 容器 `mt122-review-pg`（pgvector/pgvector:pg16，PostgreSQL 16.15，仅 127.0.0.1:**55573**，口令随机），端口预检空闲。
- 三库：`openbot_enterprise_r14c_test`（主）+ `_assigned`（MT003）+ `openbot_kb_r14c_test`（受限属主 `ent_r14c_kb` NOSUPERUSER NOBYPASSRLS，drizzle-kb 迁移经属主通道 apply，5 表在册）。
- 三步配方：① `enterprise-test-db.ts migrate`（基线 150 表 + `ent_r14c_{dir,data,opr}` 登录角色 + `ob_ent_*` 能力角色，实测四角色 NOSUPERUSER/NOBYPASSRLS/仅 data+opr+dir 可登录）② assigned + KB 库 ③ 16 任务链 generate+apply（MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070）。
- **链 journal 实测 16/16 任务在册**（`mt_task_migration_journal` 分组回显，与实现报告 §3 一致）。generate 产物写到 /tmp，未触碰树内 checkpoints。
- 七变量 env（0600，用后已销毁）；活体探针：`session_user=ent_r14c_data, current_user=ob_ent_data`（受限角色切换真实生效）。

## 2. 测试复跑（独立环境实测 vs 实现者声明）

| 项 | 实现者声明 | 复审实测 | 判定 |
|----|-----------|---------|------|
| 基线（零 MT122 交付态） | 990 / 0 / 38 文件 | **990 / 0 / 38 文件**（22.65s） | ✅ 逐字复现 |
| 聚焦 entry-context.test.ts | 21 / 0（GREEN-2） | **20 pass / 1 fail / 21 例** | ✅*（唯一 fail 见 F1：环境探针硬编码库名，非行为缺陷） |
| 全量 tests/multitenancy/ | 1011 / 0 / 39 文件 | **1010 pass / 1 fail / 39 文件**（24.72s） | ✅*（同 F1） |
| typecheck（tsc --noEmit） | exit 0 | **exit 0** | ✅ |
| biome 触及文件 | MT122 增量 3 文件零违规；app/index 6 处存量（4 err+2 warn） | **增量 3 文件 0 违规**；app/index = 6 处（4 err+2 warn：app 1026、index 839/867/901/1913/4778），与第 3 任存档 04-biome-final 逐行同码同位 | ✅ |

**基线复现方法**：将 5 个交付文件移出树 + 对 app.ts/index.ts 精确逆向 MT122 hunk（python 单次命中断言，逐 hunk 校验；`git show HEAD` BASE blob 哈希 83600fe6/ec775519 与 before-hashes 6ca171dc/c18817e3 不同属预期——后者是 BASE+240 未提交态的谨慎边界锚，与 prereq-manifest.txt 第 11/88 行、MT028/after-hashes-final 第 8 行三方一致，冻结链完整）。基线跑完即原位复原，5 文件 sha256 复验逐字节一致（4d33cc1f / 2692ea0d / df7226cc / efc7d602 / 4acf144c）。

**F1 量化**：实现者环境 w14e 下 21/0（64 expect）；复审环境 r14c 下 20/1（63 expect）——63 = 64−1 恰为该用例首断言失败中止（第二断言 current_user 未执行）。该用例的 `ob_ent_data` 半边由复审者独立探针补证为真（见 §1）。全量侧 expect 计数轻微漂移（实现者 12087/12148 vs 复审 12084/12150），pass/fail/文件数完全一致，属数据相关断言数抖动（F2）。

## 3. 变异重放（brief 要求 ≥3 条，复审实际重放全部 MUT1-5）

以树内实际哈希 4d33cc1f 为复原基准，逐条重注入 → 聚焦跑 → 原字节复原 → sha256 复验。复审环境已知 F1 用例每次必 fail（+1），故与实现者存档对照口径为「行为性 watched-fail 集合」：

| 变异 | 实现者（w14e） | 复审重放（r14c） | 行为性 watched-fail | 复原 |
|------|---------------|-----------------|--------------------|------|
| MUT1 fromRequest 失败回退默认 scope | 14 pass/7 fail | 13 pass/**8 fail** | 7 例，与存档 fail 集逐例相同（AC1 缺头/越权/中间件拒绝/拒绝码/机器 HTTP 全灭） | ✅ byte-identical |
| MUT2 工厂共享单例 | 17 pass/4 fail | 16 pass/**5 fail** | 4 例相同（AC2 双上下文差异/每请求新实例/NOT_FOUND/内部建立） | ✅ |
| MUT3 内部建立跳过 DB 成员重验 | 19 pass/2 fail | 18 pass/**3 fail** | 2 例相同（机器身份 TENANT_FORBIDDEN/越权选司） | ✅ |
| MUT4 businessFor 克隆 scope 脱离 WeakSet | 18 pass/3 fail | 17 pass/**4 fail** | 3 例相同（assertTrustedScope 拒克隆） | ✅ |
| MUT5 transaction 包装外呼 fetch | 20 pass/1 fail | 19 pass/**2 fail** | 1 例相同（AC4 零拨号用例） | ✅ |

FINAL restore-hash OK `4d33cc1f3518e4616…`（树内哈希为准）。**5/5 KILLED**。附带证实 R-MT122-4 重建保真度：mutation/run.sh 的五处逐字节片段在重建文件中各恰好命中一次。

## 4. 冻结面核对

| 冻结面 | 存档 | 复审核对 |
|--------|------|---------|
| 交付 5 文件哈希 | verification/06 | 树内实测逐一相等 ✅ |
| before-hashes（app=c18817e3 / index=6ca171dc） | checkpoints/MT122 | = prereq-manifest 行 11/88 = MT028 after-hashes-final；谨慎边界锚未被 MT122 之外的改动扰动 ✅ |
| GREEN-1 用例名（21 例） | red-green/GREEN-1 | 与重建测试文件用例名**逐字一致 21/21**（排序比对 diff 为空）✅ |
| mutation/run.sh 五片段 | checkpoints/MT122 | 五处各单次命中 ✅（MUT1-5 重放即证） |
| 03/04 biome 存档（1026/4778/839/867/901/1913） | verification | 复审 biome 实测同行同码 ✅ |
| 链 journal 16/16 | 报告 §3 | 复审库实测 16 行 ✅ |
| 实现者容器清理 | verification/07 | 活体 `docker ps -a` 无 mt122-impl-pg ✅ |
| 实现者 /tmp 残留日志（baseline/full/mut/typecheck） | 非正式证据 | 数值与报告 §4 表完全一致（旁证，非采信依据）✅ |

## 5. 专项核对

### 5.1 fail-closed 语义（本票核心安全属性）— 逐一存在于聚焦用例且通过
- 缺 tenant → `TENANT_REQUIRED`（例 3）；缺 workspace → `WORKSPACE_REQUIRED`（例 4）；跨公司 → `TENANT_FORBIDDEN`（例 5）；A 选 B 团队 → `WORKSPACE_FORBIDDEN`（例 6）——**拒绝而非默认**，用例名即断言 "never defaulted"。
- 中间件显式选择建立失败 → canonical 码拒绝（403+码），探针 handler 不达（例 7）；部分选择头（仅 tenant / 仅 workspace）→ 401/400 拒绝矩阵（例 16）。
- 无上下文消费 `requireEntryBusiness` → `ENTRY_CONTEXT_REQUIRED`（例 8，唯一读取面，无默认依赖路径）。
- 无配置行 → `RUNTIME_CONFIG_NOT_FOUND`（例 11）；资格翻转 → 下一次事务 `WORKSPACE_REVOKED`，恢复后重验通过（例 14）。
- 机器上下文拒绝：无成员资格机器身份 → `TENANT_FORBIDDEN`（例 18）；越权选司 → `TENANT_FORBIDDEN`（例 19）；无会话 HTTP → `AUTH_REQUIRED`（例 20）。
- 多租户未启用：装配级结构保证——中间件仅在 `coworker?.entryContext && config.multitenancy.enabled` 时挂载；关闭时装配逐字节还原，任何接缝消费者即拒（例 8 覆盖消费半边）。
- **MUT1 重放**证明整套用例对「回退默认范围」有真实杀伤力（7 例行为性失败）。
- 租户存在性不泄露：store.ts 中「不存在租户」与「未加入租户」走同一 membership join 失败路径 → 同一 `TENANT_FORBIDDEN`；「不存在/ suspended 工作区」刻意不可区分 → `WORKSPACE_FORBIDDEN`（源码注释明示 no existence leak）；entry-context.ts 中间件只映射 canonical 码，无存在性分支。

### 5.2 AC4 证据真实性
- 动态：`globalThis.fetch` 包装计数两用例（transaction 路径 + runtimeConfig 路径）复审实跑均 0 拨号且事务提交。
- 静态：6 模块注释剥离后网络词汇 0 命中（复审以同脚本适配本树路径重跑，CLEAN，exit 0）。
- 变异：MUT5 KILLED（外呼注入被零拨号用例当场捕获）。
- 综合判定：报告对 AC4 的声明**真实**。

### 5.3 app.ts / index.ts 装配最小性
- app.ts MT122 hunk 仅三处：import、coworker 可选字段 `entryContext?`（带 doc 注释）、usage-origin 地板之后的条件挂载块。其后注册的全部业务路由经它；此前注册的 capabilities/auth/enterprise/conversations/workspace-scope 面不经它（实读 app.ts 807–1043 行序证实：企业面 904/912、gate 1015、usage-origin 1026 均在挂载点之前）。
- index.ts MT122 hunk 仅四处：import、`authenticateEnterpriseRequest` 闭包**提取**（体内逐字节等于既有内联闭包，语义等价的重命名共享，供企业 resolver 与工厂同闭包消费——AC3）、工厂构造并入 IIFE 返回值、coworker spread。无路由顺序改动、无行为重排。
- app/index 其余 diff hunk 属 BASE+240 既有任务（MT005/006/009/010/011/027/028/030 等）与 biome 排序/格式（brief 明文「biome 排序除外」）。
- 变异锚点复查：五处 run.sh 片段全部落在新文件，未波及共享面既有行为行。

### 5.4 四任补完质量（接管注记 6 处「待补」逐项对账）
| 待补项（第 4 任接管注记） | 终态报告 | 复审独立复跑 |
|--------------------------|---------|-------------|
| 1 基线 revert 复测（990/0/38） | §4 ✅ | ✅ 990/0/38 精确复现 |
| 2 全量 1011 复跑 | §4 ✅ | ✅ 1011 例全跑，仅 F1 环境耦合 fail |
| 3 MUT1-3 实跑 | §4 ✅ | ✅ KILLED，fail 集一致 |
| 4 新增 MUT4-5 | §4 ✅ | ✅ KILLED，fail 集一致 |
| 5 typecheck | §4 ✅ | ✅ exit 0 |
| 6 biome | §4 ✅（增量 0 + 存量披露） | ✅ 同码同位 |
- 6/6 全部补齐且全部经复审独立复现。第 4 任的重建处置（R-MT122-4）披露充分：重建非重设计的三重锚（design.md 形状 / run.sh 逐字节片段 / GREEN-1 用例名）均经本复审实证成立。

## 6. Findings（分级）

| 级别 | 编号 | 描述 | 影响与建议 |
|------|------|------|-----------|
| **low** | F1 | `entry-context.test.ts:189` 硬编码实现者环境令牌 `expect(identity.database).toBe("openbot_enterprise_w14e")`。任何异名专用库（含本次复审强制的 r14c 命名）下该用例必然伪失败 | 非产品缺陷、非 AC 违背：套件缺 env 时整套显式 skip，CI 无 env 不受影响；用例意图（专用库 + 受限 ob_ent_data 通道）的另半边已由复审探针证实为真。建议后续票把断言改为从 `TEST_DATABASE_URL` 派生或断言 `openbot_enterprise_` 前缀 + 非开发库名 |
| info | F2 | expect 计数跨环境轻微抖动（基线 12087→12084、全量 12148→12150），pass/fail/文件数完全一致 | 套内存在数据相关断言数（如循环遍历种子行）；仅校准口径提示，不影响任何门槛 |
| info | F3 | 「畸形（空白/纯空格）选择头」无专门聚焦用例；现行为经代码路径核实：空白 tenant + 有 workspace → `TENANT_REQUIRED`→400，双空白 → legacy 放行（MT125 铺设范围） | 行为正确；建议 MT125 在铺设客户端选择头时补空白头边界用例 |
| info | F4 | 第 3 任 revert 造成的「孤立注释块」中间态（app.ts coworker 注释 / index.ts authenticate 注释）已随第 4 任归位，该中间态本身不可再实物验证 | 第 4 任披露诚实；归位后注释与代码对应关系已实证。仅存档备注 |

## 7. 复审结论

实现者终态报告中的全部量化声明（基线 990/0/38、全量 1011/0/39、聚焦 21/0、typecheck 0、biome 增量 0+存量 6、MUT1-5=7/4/2/3/1 fail、journal 16/16、哈希表、容器清理）经复审者在**独立 r14c 环境**亲手复算/重跑，**无一不符**；唯一实测偏差（聚焦/全量各 1 例 fail）完整归因于 F1 环境令牌硬编码，且该用例的受限角色半边为真。fail-closed 语义逐用例在案并有 MUT1 杀伤力证明；AC4 证据（动态+静态+变异三路）真实；装配最小且无行为重排；四任补完 6/6 成立。**建议验收 MT122（PASS）**。

## 8. 复审环境清理（规约：测毕 docker rm 回显）

```
# MT122 review container teardown (2026-10-18, reviewer)
$ docker rm -f mt122-review-pg
mt122-review-pg
$ docker ps -a --filter name=mt122-review-pg --format '{{.Names}}'
(empty = removed)
```
七变量 env 文件（含口令）已销毁；/tmp 复审产物（migration generate 输出、stash、变异 results.txt）留存于 /tmp/mt122-review-*，不落入树。禁 commit 遵守：HEAD=f0520524，树内改动集与复审开始时一致（仅交付 5 文件 + 既有 240 项状态）。
