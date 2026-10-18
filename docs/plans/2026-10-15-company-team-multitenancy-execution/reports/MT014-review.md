# MT014 / Issue #57 独立复审报告 —— 公司运行配置装配

- 复审者：独立 Pi 会话（Orca Task `task_8a5dc6d6d6ec` / Dispatch `ctx_dc9e25663c2c`）。只读被审文件；唯一新建文件为本报告。
- 日期：2026-10-16。被审对象：MT014 七项交付（新建 4 + 编辑 3）+ `checkpoints/MT014/` + `reports/MT014.md`。
- 方法：先逐字审阅七项交付源码与 checkpoint 证据链，再在**自建专用环境**（容器 `mt014-review-pg` @ 127.0.0.1:**55484**，pgvector/pgvector:pg16，trust，psql 探针通过，五变量 URL 显式 `ent_mt014_rev_*` 用户 + 随机口令 0600 文件、用后即删）独立复跑全部验证。**所有哈希、断言、退出码均为复审者亲手重算/重跑**，非转抄实现者存档。
- 结论速览：**七项裁决全部通过，无 Blocker**。全量回归实测 **363 pass / 0 fail / 0 skip（13 文件）**，聚焦套件 **29/0/0skip（100 expect）**，typecheck/biome/CLI 链全绿。2 条非阻塞观察见 §4。

---

## 1. 七项裁决

### 裁决 A — 纯追加 / 窄例外最小性：**通过**

- **逐字节复核（亲手执行）**：
  - 当前工作树 7 个触及文件 + 报告共 8 项 SHA-256 与 `after-hashes.txt` **8/8 一致**。
  - 从当前文件对 `changes.diff` 做 `patch -R` 逆向重建 pristine 副本，`patch --dry-run` 与实际应用均干净成功；重建副本哈希 `8d1d6ab6…`（migrate-test.ts）与 `4ede3c5f…`（migration-tool.test.ts）与 `before-hashes.txt` **逐字节一致**，且与 32 项 `prereq-manifest.txt` 链条吻合——即 MT014 前置状态与前置票收尾状态同源。
  - `schema/index.ts` 对 BASE（git HEAD）的 diff **恰为 +1 行** `export * from "./enterprise-runtime-config";`，无其他改动。
- **窄例外先例形态**：`migration-tool.test.ts` 中该穷举断言现有 **4 段同构先例注释**（MT112/MT008/MT012/MT014）；本票改动 = 断言数组追加 `"MT014"` 一行 + 4 行裁决注释，与前三代先例同形，brief 预授权（第 4 次）。`migrate-test.ts` 改动为纯追加 MT014 任务 + 注册表 1 行，**0 删除**。
- 生成物确定性：复审者本机 `generate MT014` 输出的 2 个 SQL 与 manifest 与 checkpoint `generated/MT014/` **三文件 `cmp` 全等**，`planDigest f1882005…` 与实现者存档一致。

### 裁决 B — 只收窄语义：**通过**

- **谓词逐条审**（`runtime-config.ts` `resolveRuntimeConfig` / `parseTeamRuntimeOverridesDocument`）：
  - allowlist 覆盖逐条必须在公司 allowlist 内（`OVERRIDE_WIDENS_POLICY`，报索引不报值）；
  - 默认模型必须落在**收窄后**有效面内——公司开放但团队收窄掉的模型作默认同样拒绝（测试 `an override default outside the effective allowlist is refused` 用 o3-mini 精确钉死此边）；
  - 默认 Bot 必须是公司已发布 Bot；空 allowlist 拒绝（`OVERRIDE_MODEL_ALLOWLIST_EMPTY`，D6 披露的语义决策已在模块头注与测试双钉死）；
  - 覆盖文档**没有 access 字段可声明**（形状级拒绝 `RUNTIME_OVERRIDE_INVALID`）；引用公司 `personal` 条目拒绝（`PERSONAL_CREDENTIAL_NOT_UPGRADABLE`）；遮蔽公司条目拒绝（`OVERRIDE_REDECLARES_COMPANY_CREDENTIAL`）；覆盖条目解析后固定 `access: "team"`（代码内字面量，无第二来源）；
  - `planMapping` 不在任何覆盖字段白名单里（公司级透传，ADR 0004）。
- **断言强度**：29 用例中收窄方向用整对象 `toEqual`（非单字段）、负向用 `JSON.stringify(...).not.toContain`（整序列化面不含他司/个人引用）。变异 MUT1/MUT2 实测存档 exit=1（1 fail / 2 fail），还原后 RESTORE-green 29/0/exit=0、RESTORE-sha 与 pristine 一致——**收紧谓词不是装饰，删除即被捕获**。
- 小缺口（非阻塞）：「覆盖把 defaultAgentId 置 null（清空默认 Bot）」的合法收窄路径无显式测试；谓词方向保守（null 不可能引入能力），不构成漏洞。

### 裁决 C — 泄漏面：**通过**

- **不读环境变量**：复审者 `grep -c "process.env\|Bun.env\|import.meta.env"` 对 `runtime-config.ts` = **0**；测试另有源码级断言同三模式。开关翻转用例真实改动 `process.env.OPENBOT_MULTITENANCY`（off→on）并在 finally 恢复，断言同入参输出 `toEqual` 逐字节相同——**断言真实性核实**：翻转发生在被测进程内、对比的是完整解析对象而非个别字段。
- **零凭据回显**：canary 用例构造四个含秘密形状值的拒绝路径（未知键 `apiKeyValue: canary`、越界 allowlist 条目值为 canary、personal 引用、NOT_FOUND），逐一断言 canary 与 personal ref 不出现在任何错误消息，同时断言四个拒绝码仍可行动。实现侧 `failInvalid`/`failOverrideInvalid` 只拼路径+规则，代码审阅与测试双向印证。

### 裁决 D — RLS / 角色：**通过**

- 读取路径全程 `ob_ent_data` + 事务本地 `app.tenant_id`（`set_config(..., true)`）+ ENABLE/FORCE（复审者在库上实测 `relrowsecurity=t, relforcerowsecurity=t`）。
- **MUT4 真实性**：存档显示删上下文行后 12 fail / exit=1，失败形态为合法公司也 `RUNTIME_CONFIG_NOT_FOUND`（fail-closed 方向），与 README 描述一致——该行确为 RLS 上下文唯一来源。
- **复审者亲手 SQL 探针**（自建库、事务内 ROLLBACK）：`ob_ent_data` 无上下文 0 行；`ob_ent_operator` 持 A 公司上下文向 B 公司 INSERT → `ERROR: new row violates row-level security policy`——with-check 真实拦截跨公司写。
- **写路径范围声明诚实性**：D3 声明「写 API 属后续管理票、测试经受限 operator 走真实 RLS」与代码一致：fixture 全部写入经 `verifyOperatorDatabase` 通道 + 事务 + 上下文，套件收尾 `current_user ∈ ob_ent_*` 断言覆盖每一条受限查询（复审复跑中该用例 pass）。override 的 operator UPDATE 额外要求 `app.workspace_id`，公司表 UPDATE 仅租户上下文——与表作用域匹配。测试均以受限登录运行，无 superuser 旁路（postgres 仅用于 base migrate 与复审探针，不在套件路径上）。

### 裁决 E — 表设计（对照 MT004/MT012 模板）：**通过**

迁移 SQL 逐语句审 + 活库 `\d`/目录表复核：
- 复合 FK 内嵌 tenant_id：`enterprise_runtime_config_overrides(tenant_id, workspace_id) → enterprise_workspaces(tenant_id, id)` ON DELETE cascade；公司表 `tenant_id` 即 PK → `enterprise_tenants(id)` cascade。
- ENABLE + FORCE RLS 双表齐备；`REVOKE ALL … FROM PUBLIC, ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator` 与 MT004 模板逐字同构。
- 最小授权（活库 `role_table_grants`/`role_column_grants` 实测）：`ob_ent_data` 仅 SELECT；`ob_ent_operator` = SELECT + INSERT + **列级 UPDATE(document, revision, updated_at)**（tenant_id/workspace_id/created_at 不可更新）；PUBLIC **0 授权**；`ob_ent_directory` 无任何策略与授权（impact 说明披露的理由成立：配置不是逐主体目录数据）；**`ob_ent_identity_operator` 零策略零授权**（仅出现在 REVOKE 名单中）。
- journal 实测：`mt_task_migration_journal` 含 MT014 两步，`statement_digest` 与存档 manifest 逐字节一致（`ebce5e3c…` / `be76e1fe…`）。

### 裁决 F — 无进程级全局状态：**通过**

- `resolveRuntimeConfig` 为纯函数：输入只有入参；输出 `deepFreeze`（递归含数组元素）；测试断言 `Object.isFrozen` 三层 + 赋值抛错 + `structuredClone` 入参前后逐字节相同；MUT3 删冻结即被捕获（exit=1）。
- 无模块级可变缓存：缓存键 `runtime-config/v1/t=…/w=…/c=<rev>/o=<rev|->` 只由入参派生；revision 3→4 测试证明无陈旧进程缓存。
- schema barrel +1 行为纯 re-export，与既有 30+ schema 模块同模式，无新副作用形态。

### 裁决 G — D1 决策披露（不动 index.ts / config.ts 装配）：**通过（披露诚实且成立）**

- 复审者亲手重算：`server/src/index.ts` = `addc265c…`、`server/src/config.ts` = `06f86e2d…`，与 MT014 prereq 记录**逐字节一致**（未被 MT014 触碰）。
- D1 的论证成立：票面要求「按公司/团队解析**而不是**启动时装配一份全局配置」，解析按调用发生、进程级装配段正是待移除形态；brief 可写清单只授权「装配段纯追加」而非替换遗留装配；接口（`createRuntimeConfigService(data)`）已冻结。范围声明与 brief 边界一致，且已在报告 §6 披露遗留装配路径未替换的事实与去向（后续票）。

## 2. 独立复跑记录（全部亲手执行，含退出码）

| # | 步骤 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 1 | 端口预检 55484（`lsof`）；容器 `mt014-review-pg`（pgvector/pgvector:pg16，trust）；`pg_isready` + `select version()` = PostgreSQL 16.15 探针 | 通过 | 0 |
| 1b | 五变量 URL（TEST/SETUP/DIRECTORY/DATA/OPERATOR + `MT003_ASSIGNED_TEST_DATABASE_URL`），显式 `ent_mt014_rev_{dir,data,op}` 用户 + 随机口令，env 文件 0600，双库（review + assigned） | 建库/建文件成功 | 0 |
| 2a | `bun scripts/enterprise-test-db.ts migrate`（base schema + `ob_ent_*` capability 角色 + 三个受限登录，`\du` 实测 3 登录 + 4 capability 角色） | `migrations-applied ok` | 0 |
| 2b | 按依赖序 generate+apply：**MT004 → MT008 → MT112 → MT012**（journal 12 行留痕，顺序正确无乱序） | 4×applied | 4×0 |
| 2c | MT014 CLI 链：dry-run（2 步 24 语句，digest 与存档一致）→ generate（与 checkpoint 三文件 `cmp` 全等）→ apply → 重复 apply = `up-to-date` | 收敛 | 4×0 |
| 3 | `bun test tests/multitenancy/runtime-config.test.ts --timeout 30000` | **29 pass / 0 fail / 0 skip，100 expect** | 0 |
| 4 | 全量 `bun test tests/multitenancy/ --timeout 60000`（含 MT003_ASSIGNED env，真实 apply 用例未 skip） | **363 pass / 0 fail / 0 skip，8539 expect，13 文件** = 334（现基线含并行票 revocation 29）+ 29（本票） | 0 |
| 5a | `cd server && bun run typecheck` | 通过（含补装缺失 devDependency `eventsource@3.0.7` 后） | 0 |
| 5b | `bunx biome check` 7 触及文件 | `Checked 7 files. No fixes applied.` 0 告警 | 0 |
| 6 | 活库抽查：`pg_policies` 8 条角色/cmd 逐条符合；`relforcerowsecurity=t`×2；授权面/列级 UPDATE/journal digest（见裁决 E/D）；亲手 RLS 跨公司拒绝探针 | 符合模板 | 0 |
| 7 | 清理：`docker rm -f mt014-review-pg`；0600 env 文件与 /tmp 中间产物删除；`lsof :55484` 无监听 | 完成 | 0 |

## 3. 哈希链复核汇总（亲手重算）

- 8/8 交付物（含报告）= `after-hashes.txt`。
- pristine 重建（`patch -R` 干净应用）= `before-hashes.txt` = `prereq-manifest.txt` 同名条目。
- 32 项 prereq 中 29 项今日实测仍逐字节一致；3 项 drift 全部归因清楚（见 §4.1）。
- 变异链：pristine `0a8bc3cd…` = RESTORE `0a8bc3cd…` = 当前文件哈希；4 份 MUT 存档均 exit=1 且失败用例靶向正确。

## 4. 观察（非阻塞，不影响裁决）

1. **工作树含并行票在制工作（披露，非 MT014 缺陷）**：32 项 prereq 今日重算有 1 项超出 MT014 两个授权编辑之外的 drift——`server/src/enterprise/tenancy/workspace-admin.ts`。归因证据：MT014 自身 close-out replay（22:40:51）该文件仍 OK；现文件 mtime 22:42 且新增 `import { recordRevocationAuditEvent } from "./revocation"`，`revocation.ts/.test.ts`（22:22–22:42）为另一票据的在制交付，发生于 MT014 会话窗口之后。MT014 的「冻结面零改动」声明在其会话窗口内成立；本报告 §2 的全量 363/13 文件即包含该并行票测试（这也正是复审 brief 预期 363=334+29 的口径）。建议 coordinator 在合入前对并行票单独收口哈希。
2. **GREEN 前的 7 个中间失败未单独存档**：`GREEN-1-first-run.txt` 实为修复后首个绿跑（29/0/exit=0），修复前失败仅在报告行文中披露、无逐个存档。RED→GREEN 主链证据（缺模块 exit=1 → 29 pass exit=0）完整，此为证据粒度的小缺口，非诚信问题。
3. 夹具 `runOperator` 对公司 B 写入也固定携带 company-a 的 `app.operator_principal_id`：现配置表策略不消费该 GUC，故无实际影响；但后续管理票实现写 API 时不得沿用此宽松脚手架（应按租户取真实 operator principal），在此留痕提示。
4. 覆盖「defaultAgentId → null」合法收窄路径无显式用例（谓词保守，无风险），后续维护可补一行断言。

## 5. 结论

七项裁决（A 纯追加/窄例外、B 只收窄、C 泄漏面、D RLS/角色、E 表设计模板、F 无全局状态、G D1 披露）**全部通过**；独立复跑七步全部达成复审 brief 门槛（29/363/typecheck/biome/CLI 链），且关键哈希、digest、策略授权面均为复审者亲手重算与活库实测。实现者报告 `reports/MT014.md` 中的量化声明与独立实测**无一不符**；诚实披露（D1–D7）经核实成立。复审环境容器与凭据已按规清理。**建议验收 MT014。**
