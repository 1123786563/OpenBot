# R4-backend 独立复审报告（R4-1..R4-6）

角色：独立 backend reviewer（只读；本报告为唯一产出文件）。工作区 `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`，BASE `9057aeeb`）。复审日 2026-10-20。

输入：`ocr/ocr-fix-plan-round4.md`、`tasks/R4-backend.md`、`tasks/R4-backend-report.md`、`docs/specs/2026-10-19-plugin-package-marketplace-design.md`（§6/§7/§8）、`docs/adr/0008`。

## 一、结论

| 维度 | 结论 |
| --- | --- |
| **SPEC compliance** | **PASS**（R4-1..R4-6 全部按裁决口径落地；偏差 2/3/4/5/6 逐条核实为真且可接受） |
| **Code quality** | **PASS**（0 blocking；3 条 low 非阻断 findings + 2 条 info，见 §四） |
| **Blocking findings 数** | **0** |

## 二、逐项核对表

| 项 | 要求（fix-plan/brief 口径） | 证据与结论 |
| --- | --- | --- |
| R4-1 | 镜像补 `enterprise_package_install_scope_id_uq` (tenant,workspace,id) 唯一索引 | ✅ `server/src/db/schema/enterprise-plugin-packages.ts:128-132` 与权威（migrate-test.ts:2554）名、列序完全一致；typed parity 钉名（schema-drizzle-parity.test.ts:48-51）；live DB `indexColumns` 恰为三列（package-grants.test.ts:306-311） |
| R4-2 | 纯追加重建 grants PK 为六列（含 tool_ref）；镜像同步；parity 更新；正测 | ✅ `git diff HEAD -- migrate-test.ts` = 563 增 / **0 删**（纯追加，已入账步骤 digest 由 journal 守卫钉死）；追加步骤 `package_grant_pk_tool_ref`（migrate-test.ts:2653-2662）DROP+重建为 `(tenant_id,install_id,generation,bot_id,resource_id,tool_ref)`；镜像 primaryKey 六列名+列序逐项一致（schema:476-486）；parity 测试 `toEqual` 钉精确列序（parity.test.ts:59-66）；等价性论证成立：旧 5 列 PK 唯一 ⇒ 新 6 列 PK 唯一（扩列只会更易满足），既有行 tool_ref 恒为 ''，唯一性只放宽=expand-compatible；pkg03 正测（两 tool_ref 共存 + born-revoked 重复撞 PK + skill 行为不变）与 DDL 现场断言全绿 |
| R4-3 | apply() 同一写事务内复验 connector install；品牌化错误→4xx；驱动测试证明零残留 | ✅ 复验在 `store.transaction` 回调内、写 linkRows 前，用 `tx.db` 逐个去重复验且按 tenant+workspace+id 定点（install-service.ts:652-679）；`CONNECTOR_INSTALL_MISSING` → routes 409 + 固定文案（routes.ts:124-131,177-190）；shared 闭集未动（内部码落 server contracts，偏差 3 如实）；驱动测试：plan 成功→setup 连接删除→apply 拒、install/link/changes 全零行、plan 未消费（package-install.integration.test.ts:822-888）；路由层 409 映射与品牌化响应体测试全绿 |
| R4-4 | CREATE OR REPLACE 强化敏感键防线（递归+大小写不敏感）；不改已入账步骤；operator 直调测试 | ✅ 追加步骤 `package_expert_create_function_hardening`（migrate-test.ts:2794-2834）：签名/返回/`SET search_path=pg_catalog`/built_in 判定/上下文重验逐字保留；jsonpath 为 package_hardening 既有 `$.** ? (@.type()=="object").keyvalue()` 风格 + `flag "i"`，键集=原 endpoint/auth 列表∪秘密载体列表（与 migrate-test.ts:2498 逐项比对一致）；live `proacl`={owner,ob_ent_operator}、无 PUBLIC——OR REPLACE 保留 ACL 实证；`proconfig` 仍为 pg_catalog；implementer 3 样本 + 我的 10 个 adversarial 样本（见 §三.2）全部行为正确；直调测试走真实 operator 角色（package-expert.test.ts:1186-1252）含 ghost-row 零残留与正常模板正控 |
| R4-5 | 索引路径入 config，env `OPENBOT_PLUGIN_MARKETPLACE_INDEX`，默认解析不变 | ✅ `config.pluginMarketplaceIndexPath`（config.ts:2959-2961，`optional()` trim 语义）；index.ts:1152 改读 config；默认 `fileURLToPath(new URL("../../plugins/marketplace.json", import.meta.url))`——config.ts 与 index.ts 同在 `server/src/`，我以 URL 解析实证两者落到同一绝对路径（`<repo>/plugins/marketplace.json`，文件存在）；`loadConfig()` 默认吃 `process.env`，env 覆盖生效路径成立 |
| R4-6 | action CHECK 对齐权威；头注释八表对齐；drizzle.config 按 F1 改写 | ✅ 镜像 CHECK 六值闭集（schema:815-818）与权威两步（:2604、:2751）终态一致；头注释"Eight append-friendly tables"与实际 8 个导出表逐一对应；drizzle.config 注释块按 F1"parity 守护下的受控 generate 源"改写，条目未动且 parity contains 断言仍钉住 |

边界核查：本票描述的 14 个触碰文件全在 `server/`；`git status` 中 `shared/` **零改动**；`app/` 改动属并行 frontend 票（R4-7..R4-9）与既有切片，与 backend 票文件不相交。

## 三、Fresh 验证（全部本人新跑，证据目录独立命名）

### 3.1 测试运行

- **native**：`E2E_UNIT_OUTPUT=.e2e/r4-review-backend-native bunx e2e run --config e2e.unit.config.ts <7 个触碰面文件>` → **7 files / 133 tests 全过**（与报告 §4.1 数字一致）。
- **driven**：pkg02 → `.e2e/r4-review-backend-driven-pkg02` passed；pkg03（子串过滤同时命中 pkg03b，与偏差 4 描述一致）→ `.e2e/r4-review-backend-driven-pkg03` passed（2 组断言）；pkg04 → `.e2e/r4-review-backend-driven-pkg04` passed。
- **bun 直跑对照**（按 ADR 0008 只认组内文件）：`-t "R4-2"` / `-t "R4-3"` / `-t "R4-4"` 各 1 pass；整文件 pkg03=16、pkg04=15、pkg02 两文件=35，与报告一致；`migration-tool.test.ts` 41 pass / 1 skip / 0 fail——唯一 skip 是 `MT003_ASSIGNED_TEST_DATABASE_URL` 未设的既有条件集成测试（:1099-1122，环境门控显式标注，非 R4 静默跳过）；journal 守卫 10 条全过。
- **门禁**：`bun run --filter server typecheck` → 恰好 3 条 error TS，全部 `scripts/bootstrap-local-gateway.ts`（既有 bootstrap 错误，零新增）；`bunx biome lint` 13 个触碰文件干净；`server/src/index.ts` 5 条 findings（noConsole×3 @1014/1042/1076、noNonNull×2 @5397/6956）经 BASE 逐行比对为既有（BASE 同一 console 语句在 1004/1032/1066、断言在 5298/6856，行号平移吻合），R4-5 触碰区（~1146-1156）零新增。

### 3.2 SQL 直读与 adversarial 样本（容器 openbot-enterprise-test-pg，仅 SELECT）

- live：`enterprise_package_grant_pk` = `PRIMARY KEY (tenant_id, install_id, generation, bot_id, resource_id, tool_ref)`；journal PKG02=3 / PKG03=6 / PKG04=5；函数体含 `$.**`@993 与 `flag "i"`@1206；`proacl` 无 PUBLIC、operator 有 EXECUTE；`proconfig`=search_path=pg_catalog。
- 追加重放：对已迁移库 dry-run `migrate PKG03` → "已应用 6/6；待应用 0 步"，`migrate PKG04` → "已应用 5/5"（manifest 含 `0006_...grant_pk_tool_ref` 与 `0005_...create_function_hardening`）——已应用步骤 digest 与当前计划逐步相等，无文本漂移。
- **我的 10 个 adversarial jsonpath 样本**（直接对 live 函数体内的 path 跑 `jsonb_path_exists`）：

| 样本 | 期望 | 实测 |
| --- | --- | --- |
| T1 顶层 `{"endpoint":...}`（回归探针：防 `$.**` 漏根对象） | 拒 | ✅ caught |
| T2 `{"Remote":{"EndPoiNt":"x"}}` 大小写混合嵌套 | 拒 | ✅ caught |
| T3 `{"list":[{"apiKey":"k"}]}` 数组内对象 | 拒 | ✅ caught |
| T4 三层深 `bearer` | 拒 | ✅ caught |
| T5 `{"notes":["endpoint","Token"]}`（值含敏感词，键不含——不得误伤） | 过 | ✅ not caught |
| T6 正常 `{"agentType":"built_in","skill":"summarize"}` | 过 | ✅ not caught |
| T7 顶层 `{"Token":"x"}` | 拒 | ✅ caught |
| T8 `{"auth":123}` 非字符串值 | 拒 | ✅ caught |
| T9 `{"123":{"endpoint":"x"}}` 数字样键内嵌对象 | 拒 | ✅ caught |
| T10 `{"a":[[{"secretRef":"x"}]]}` 嵌套数组 | 拒 | ✅ caught |

结论：递归 + 大小写不敏感无绕过路径（T1 证明 `$.**` 覆盖根对象，对旧 `?|` 顶层防线无回归）；T5 证明不误伤值文本。数字键在 JSON 中恒为字符串，T9 证实其内嵌对象仍被扫描。

### 3.3 Deviation 2 核实（migration-tool.test.ts 补记 "PKG04"）

diff 仅 +8 行：PKG02/PKG03 两行及其注释为先前切片所加，**本票实际只追加 `"PKG04"` 一行 + 注释**（"PKG03<PKG04" 排序位正确）。红/绿论证成立：TASKS 注册表含 PACKAGE_EXPERT_TASK（migrate-test.ts:2859）⇒ `ALLOWED_TASK_IDS`（由 TASKS 派生）含 PKG04 ⇒ 修复前字面量 `toEqual` 清单必红；修复后该文件 41 pass。补记沿用文件内 ruling #5 先例并留注释，无新风险。**如实。**

## 四、Findings

| # | Severity | Blocking | 位置 | 证据与说明 |
| --- | --- | --- | --- | --- |
| F-1 | low | 否 | `install-service.ts:658-679` | R4-3 复验是普通 SELECT（无 `FOR SHARE`）：READ COMMITTED 下若 connector install 删除恰在"复验之后、linkRows 插入之前"提交，仍会以裸 23503 冒出。窗口从 10 分钟压到毫秒级，裁决要求的"事务内复验"已如实落地，故非阻断；后续可用 `FOR SHARE`（对齐 spec §8 connector-install 锁级）彻底闭合 |
| F-2 | low | 否 | `package-grants.test.ts:321-335` | live PK 断言按"逐列 contains"而非有序相等（列序已由 typed parity `toEqual` 钉死，组合覆盖充分）；如后续把 DDL 断言升级为整串比较更稳 |
| F-3 | low | 否 | `schema-drizzle-parity.test.ts:48-51` | R4-1 索引在 typed parity 只钉名未钉列（列在 live 测试钉）；同 F-2 属覆盖深度备注 |
| F-4 | info | 否 | migrate-test.ts:2821 | 强化版键名正则是锚定的 `^(...)$`：`my-endpoint`/`secretQuestion` 类键不拒——与 package_hardening 既有语义一致（键名探针是纵深防御之一，主门仍是 agentType='built_in' 判定），记录为接受口径 |
| F-5 | info | 否 | 报告偏差 6 | scratch 库端到端追加演示未做（环境受限，已如实记录）；纪律由纯追加 diff（0 删行）+ 10 条 journal 守卫 + live `6/6、5/5 up-to-date` 重放三重补偿，本复审实测三者皆真 |

## 五、Fresh 证据目录

- `.e2e/r4-review-backend-native/`（native 7 文件 133 用例，report status=passed）
- `.e2e/r4-review-backend-driven-pkg02/`、`.e2e/r4-review-backend-driven-pkg03/`（含 pkg03b 组断言）、`.e2e/r4-review-backend-driven-pkg04/`（均 passed）
- live DB 探针与 10 个 adversarial 样本输出见 §3.2（本报告内联，另有 dry-run manifest 原文）
