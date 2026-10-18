# MT069 独立复审报告（Issue #112 — 公司计费 Customer 映射与公司/个人账户类型）

复审者：独立 Pi 会话（coordinator 下发 brief：`briefs/MT069-review-brief.md`）。
复审树：`i10-review-mt069`（coordinator 装配 = EXE 67 项前置 + 本票 7 交付）。BASE f0520524。
授权边界：只读被审文件；唯一新建 = 本报告；未修复、未提交/推送/合并。

## 结论

**通过（pass with findings）** — 票面四条验收 + brief 附加审计要求全部在真实 PostgreSQL 上
独立复现并逐条证实；既有扣费行为零变化经三重回归 + 树级 diff 双重证实；三处窄例外经
**逆向应用 + 逐字节哈希闭环** 证实为纯追加。发现 4 项非阻塞问题（见 §6），均为证据卫生 /
格式级，不影响行为、隔离与验收。

## 1. A — 五条验收逐条裁决（全部成立）

| # | 验收 | 独立证据 | 裁决 |
|---|---|---|---|
| AC1 | 映射双向唯一在 DB 层 + 23505 竞态兜底 + 无改绑路径 | 活库 `pg_indexes`/`pg_constraint`：`billing_customer_mappings` PK(tenant_id) + UNIQUE(external_customer_id) 两方向唯一索引实存；直连 SQL 探针 P1/P2 证实两方向插入均被 23505 拒绝（P1=customer_unique、P2=pkey）；服务文件 import 无 update/delete，无任何改绑/解除路径；服务层 23505 兜底统一映射 `CUSTOMER_MAPPING_CONFLICT` | ✅ |
| AC2 | 显式 account_type 不猜测 | 活库 CHECK `billing_credit_accounts_type` + 行形状 CHECK `row_shape` 实存，探针 P3/P4 证实（quarantined+type、active-company 无 tenant 均拒）；公司账户 Customer 从映射派生（无映射 → `CUSTOMER_MAPPING_REQUIRED`，测试钉死）；个人账户撞公司映射 Customer → `CUSTOMER_COMPANY_MAPPED`；同人第二个人账户 → `ACCOUNT_ALREADY_EXISTS`（account_key 派生 CHECK + partial UNIQUE，探针 P6 证伪错误派生键） | ✅ |
| AC3 | 未知记录隔离不默认归类 | 隔离行强制 type/key/tenant/owner 全空（`row_shape`）+ 必留原因（`quarantine_reason`，探针 P5 证伪缺原因）；已分类再隔离 → `ACCOUNT_ALREADY_CLASSIFIED`；隔离行上注册 → `ACCOUNT_ALREADY_EXISTS`（晋升属 MT070+，无静默改类路径） | ✅ |
| AC4 | expand-only 既有计费四表零改动 | 列清单硬编码断言 + 真实 writer grant→reserve→settle 全链路（charged/applied=1234、余额 3766、台账键 `reservation:<id>` 全为 writer 真实产出）+ used≤total CHECK 越顶 UPDATE 反证——三者在**本复审新迁移的库**上随 599 全量回归一并跑通；另核 `git status/diff`：`schema/billing.ts`、`schema/credits.ts`、`billing/`（除新文件）相对 HEAD 零改动 | ✅ |
| AC5 | 审计（幂等重放不重复审计） | bind/register/quarantine 每个新成功写入恰一行审计；幂等重绑/重注册/重复隔离提前返回、不写审计（测试 "re-binding…writes nothing" 等）；`listAccountAudit` 按公司/Customer 过滤 newest-first | ✅ |

补充：8 条直连 SQL 负向探针全部按设计拒绝/放行（P1–P8），证明约束在 DB 层独立于服务层成立。

## 2. B — 结构隔离（成立，D2 披露处置：接受）

- 活库 `information_schema.role_table_grants`：`ob_ent_directory/data/operator` 与 `PUBLIC`
  对三新表**零行授权**（本复审容器实测）；三新表与四张既有计费表的授权形状逐表相同
  （仅 owner postgres）——D2「跟随 billing 域访问模型」与事实一致。
- RLS 状态：三新表 `relrowsecurity=f`，与 billing_customers/credit_grants 相同（billing 域
  无 RLS 基线）；enterprise 域 0056 基线风格（ENABLE+FORCE）未被触碰，也不适用于账务域
  expand。personal/quarantined 行 tenant_id 为 NULL，租户 pin RLS 臂结构上不可表达——
  D2 的理由成立。**接受该披露**：受限角色的隔离以「零表级授权」实现，强于 RLS。
- journal：`mt_task_migration_journal` 21 步全落账（10 任务：MT004:2、MT008:2、MT112:4、
  MT012:2、MT014:2、MT010:2、MT009:2、MT077:2、MT026:2、MT069:1）；MT069 statement_digest
  与 generate manifest 内容摘要一致。

## 3. C — 计费零变化三重回归（证据真实覆盖，成立)

三重回归在本复审独立迁移的专用库上真实执行并通过：(a) 四表列清单 information_schema
硬编码断言；(b) `createCreditWriter` 真实 grant→reserve→settle（×100 整数、幂等键派生）；
(c) used≤total CHECK 拒绝越顶 UPDATE。断言值（1234/3766/`reservation:<id>`）为运行期
真实产出（D7 属实）。树级：既有计费域源文件相对 HEAD 零改动。**「既有扣费行为零变化」
裁决成立。**

## 4. D — 窄例外 3 处（全部纯追加，字节级闭环）

方法：对现树（after）逆向应用 MT069 专属增量，对结果取 SHA-256，与 coordinator 证明的
before 哈希比对：

| 文件 | 逆向剥离后 SHA-256 | coordinator before | 结论 |
|---|---|---|---|
| `scripts/multitenancy/migrate-test.ts` | `09bf04006ff459fe…2a6a68b`（全量） | `09bf0400…` | ✅ 纯追加 +77/−0（块注释+PAYER_ACCOUNT_TASK+TASKS 条目） |
| `tests/multitenancy/migration-tool.test.ts` | `2a1ce227f1fdda59…dad4392`（全量） | `2a1ce227…`（全量） | ✅ 纯追加（3 行裁决注释 + 1 条目） |
| `src/db/schema/index.ts` | `e1954c8a32b11521…ddc3841`（全量） | `e1954c8a…` | ✅ 纯追加 +1 行 barrel |

- MT069 任务 = 单步 `payer_accounts_tables` **8 条语句**（3×CREATE TABLE + 2×UNIQUE INDEX +
  1×partial UNIQUE + 2×INDEX），dry-run 实测 "待应用 1 步 / 8 条语句" 与存档一致。
- barrel +1 与 `schema/payer-accounts.ts` 导出一致（3 表对象；typecheck 0 佐证）。
- allowlist sort() 序：`…MT026, MT069, MT077…`，MT069 位于 MT026 与 MT075 的字典序区间
  （MT075 无迁移任务、正确缺席），`ALLOWED_TASK_IDS` 由 `[...keys()].sort()` 派生。
- **"ruling #5 第 7 次" 计数口径（定性）**：注释链自身序数不一致——MT009 标 "第 4 次"、
  MT014 标 "MT112 第 4 次沿用"、MT077 标 "第 6 次"。以「MT112=ruling#5 本体记 1、其后每次
  断言追加 +1」计，MT069 实为第 **8** 次；任何口径都无法精确得出 "第 7 次"。**实质裁决**：
  先例链真实存在（9 条追加条目全部带 ruling #5 系注释）、本票 brief 已预授权、增量仅限
  断言 + 注释——序数笔误不影响授权与纯度结论，属记录卫生问题（F3）。

## 5. E — TDD 链、变异 13/13、披露处置

- **TDD 链真实**：RED-1（allowlist 断言先行，576 pass/1 fail，失败用例恰为本断言）→
  GREEN-1（注册表追加后 42/0）→ RED-2（模块缺失 error）→ GREEN-2（22/0）；原始存档与
  red-green.md 叙述一致。GREEN-2 存档 55 expect() → 交付态 57 expect()，与 after-hashes
  注记的"断言强化后重验"时间线互洽（强化后 01/02 重归档，见 F1）。
- **变异 13/13 KILLED**：`mutation/results.txt` 逐条 pass/fail 计数齐全；RESTORE-OK 哈希
  `e3042dbc…` 与本复审现树服务文件哈希**逐位一致**。
- **D1（票号 #111→#112）核实成立**：本复审 `gh issue view 112` 实取，票面四验收/
  Verification 路径与实现一致；#111 = MT068 属实。报告所述无误。
- **全量账目**：本复审复现 **599 pass / 0 fail / 0 skip / 23 文件**（= 577 基线 + 22 新增），
  聚焦 **22/0/0**。基线 577/0/22 无法在本树直接重放（需回退交付件，未授权），以 599−22
  算术自洽 + 实现方 00/D6 存档采信；D6 对存档时序的披露与证据吻合（pristine 未伪造）。
- 其余披露：D3（幂等语义）、D4（晋升范围）、D5（审计幂等）、D7（真实值）均与实现/测试/
  活库行为一致，接受。

## 6. 发现（非阻塞）

- **F1（门禁证据过期 — 唯一门禁类发现）**：`verification/04-biome.txt`（02:02 存档）早于
  `payer-accounts.test.ts` 最终"冲突消息断言强化"（after-hashes 注记）；本复审以仓内固定
  版本 biome 2.5.10 复检 7 个触及文件，交付态测试文件报 **1 个 format error**（2 处同型
  hunk：`expect(...startsWith(...)).toBe(true)` 折行）。报告 "biome 0 error 0 warning (04)"
  对**交付字节**不成立。仅格式、无行为影响；建议后续票据授权后 `biome format --write` 并
  重存 04。复审按"不修复"边界未动。
- **F2（`before-hashes.txt` 缺失）**：报告/设计称哈希存档含 "before/after-hashes"，检查点
  中 `after-hashes.txt` 存在而 `before-hashes.txt` 不存在。已由 coordinator 证明哈希 +
  本复审逆向闭环（§4）补证；属证据归档不一致，非实质缺陷。
- **F3（"ruling #5 第 7 次" 序数不可复算）**：见 §4；注释链序数记账不精确（应记第 8 次）。
- **F4（端口偏离，程序性）**：brief 指定 55503 预检时被并行复审容器 `mt079-review-pg`
  占用；按预检规则改用 **55513**（同约束：仅回环、trust+随机口令）。其余完全按 brief 执行。
- 日常级备注（无需行动）：服务写路径返回体 `createdAt` 用客户端 `new Date()` 近似而非
  DB 生成值（幂等重放路径返回真实行）；不在验收语义内。

## 7. 独立复跑记录

1. 容器 `mt069-review-pg`（pgvector/pgvector:pg16 → PostgreSQL 16.15，trust+随机口令，
   `127.0.0.1:55513`）；双库 `openbot_enterprise_mt069r` + `…_assigned`；六变量 env 0600。
2. base migrate `{"type":"migrations-applied","status":"ok"}` + 十任务依赖序
   dry-run→generate --out→apply --manifest 全部 applied 并记 journal（§2）。
3. 聚焦 `payer-accounts.test.ts`：**22 pass / 0 fail / 0 skip**。
4. 全量 `bun --no-env-file test tests/multitenancy/ --timeout 30000`：**599/0/23 文件**。
5. `bunx tsc --noEmit` 退出码 0；biome 2.5.10 触及 7 文件 → 1 format error（F1）。
6. 活库抽查：索引/CHECK/授权矩阵/RLS 状态/journal 全部符合（§1/§2）；8 条 SQL 负向探针。
7. 清理：`docker rm -f mt069-review-pg`、env 文件删除、并验证不存在（见下）。

（复审环境无复用实现方容器/端口；`bun install --frozen-lockfile` 仅安装 gitignore 依赖，
未触碰 tracked 文件。）
