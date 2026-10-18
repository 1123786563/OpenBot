# MT013 / Issue #57 — 独立复审报告

- 复审者：第五任独立 Pi Reviewer（Dispatch `ctx_9c9174efae1a`，Task `task_adfa296eae4b`）
- 被审交付：实现者报告 `reports/MT013.md`（sha256 `e552054e…`，manifest 复算一致）+ `checkpoints/MT013/**`
- BASE：`f0520524f0faa2b4533b9d2f1aa692c8f907ba71`（== 本树 git HEAD，复核一致）
- 复审方式：只读被审文件；全部关键断言亲自重放（专用库为本复审**删除重建**后全新迁移，非沿用前任状态；冒烟工件由本复审用工作树生成器现场重产）；复跑产物留存 `/tmp/mt013-review-mine/`
- 前任增量（`/tmp/mt013-review/`，第三任）仅作交叉对照，未作为结论输入；第四任（502 风暴）与第三任报告阶段死亡（orchestration recovery）的发现**未预设本报告任何结论**——F1 系本复审独立重放后自行定级

## Verdicts

| 维度 | 结论 |
|------|------|
| **Spec compliance（Issue #57 四条验收）** | **PASS（带 1 个 medium 缺陷）**：AC1/AC2/AC4 全部成立；AC3 在 waivers 文件损坏/缺失这一输入类上被违背（F1）——fail-closed 方向保持（exit 1、绝不带缺口启动），但零结构化审计记录、未捕获异常栈上抛 |
| **Code quality** | **良好**：纯函数 evaluator + 可注入 IO 的分层干净，拒绝语义（列全缺口、不短路、只读探测）落地到位；1 medium（F1 错误 containment 缺口）+ 1 low（F2 格式与证据失真）+ 1 info（F3 输入硬化） |

## 1. 快照核验（brief 第一步，亲自执行）

- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` ✓；git 状态 = `M config.ts / enterprise-tenancy.ts / store.ts / index.ts / config.test.ts` + 清单内 untracked ✓（与 brief 预期一致；config.test.ts 的 M 即被审新 describe + D1 一行）
- **manifest 复算**：按双基准路径（deliverables 相对 `server/`、checkpoints 相对 `checkpoints/MT013/`、报告相对仓库根）逐条 `shasum -a 256`——**34/34 一致**；仅两份 manifest 文件的自引用（声明 `fc40b7f1…`，实际互为字节相同副本 `588c0231…`）失配，为 brief 已知形态，不计。两份 manifest 互相字节一致 ✓
- **增量证明独立复算**：从 `changes.diff` 提取 index.ts 两个 hunk，对工作树副本反向 patch → `8c2583847bb056bbb27ef8782542be476f87677b42619dc3a5d162dc43678c5d`（= prereq manifest 声明值，逐字节一致）✓；再正向回放 → `da645dc6…`（= 最终态）✓。往返闭合，报告增量声明为真
- 工作树未污染：本复审未修改任何被审文件（唯一写入 = 本报告 + `/tmp`）

## 2. 独立复跑（全部亲自执行，命令与退出码）

环境：容器 `mt013-review-pg`（pgvector/pgvector:pg16 @127.0.0.1:55465，复用前任容器但**数据库删除重建**）；psql 探针就绪（1 次通过）；角色/成员资格形态迁移后复核（`ent_m13_{dir,data,op}` 登录角色各恰持一个 `ob_ent_*` 能力成员资格，能力角色 NOLOGIN）。

| # | 命令 | 退出码 | 结果 |
|---|------|--------|------|
| 1 | `bun --no-env-file scripts/enterprise-test-db.ts migrate`（重建后的空库） | 0 | `migrations-applied ok` |
| 2 | `bun --no-env-file scripts/multitenancy/migrate-test.ts migrate MT004 --apply --manifest <现场重算的 manifest>`（吸取 MT112 L1） | 0 | 2 步 15 语句入 journal |
| 3 | `bun --no-env-file test tests/multitenancy/startup-checks.test.ts --timeout 30000`（五变量 env） | 0 | **33 pass / 0 fail / 0 skip**（83 断言；5 个真实库用例全跑） |
| 4 | `bun --no-env-file test tests/config.test.ts` | 0 | **155 pass / 0 fail** |
| 5 | `bun --no-env-file test tests/multitenancy/ --timeout 30000`（+ `MT003_ASSIGNED_TEST_DATABASE_URL`） | 0 | **181 pass / 0 fail / 0 skip**（7399 断言，7 文件；30s 超时即绿，未触发 D4 的 60s 需要） |
| 6a | 相邻套件 config + identity-app-wiring + cull-sweep-wiring `--timeout 60000` | 0 | 167 pass / 0 fail |
| 6b | `tests/shared-wiring.integration.test.ts` 单独运行 | 0 | 3 pass / 0 fail |
| 7 | `cd server && bun run typecheck` | 0 | tsc --noEmit 干净 |
| 8 | `bunx biome check`（五触及文件，repo biome 2.5.10） | 1 | 8 errors + 1 warning（见 §4 F2 与 D3 处置） |
| 9 | 冒烟（boot-slice 复现 index.ts 启动段接线，`/tmp/mt013-review-mine/run-slice.sh`，见 §3） | 见表 | 见表 |

注：报告声称的 181=148+33 基线加法与 `BASELINE-before-mt013.txt`（148/6 文件）及本次终态复跑吻合。

## 3. 冒烟重放（boot-slice：与 index.ts 646-669 行接线逐行同构，直接驱动工作树 config.ts + startup-checks.ts）

前置：本复审用工作树 `scripts/multitenancy/inventory.ts` 现场重产工件——raw 清单 **539 入口 / 539 unowned**（与报告及 checkpoint `real-inventory-artifacts.sha256` 所指同源数字独立重现）；owned 清单以自建 ownership 映射（23 closures → MT000）重产得 **539/539 owned, 0 unowned**。

| 变体 | 场景 | 退出码 | stdout 记录 | 判定 |
|------|------|--------|------------|------|
| 3a | 开关 on、无 inventory | **1** | 恰好 1 条结构化记录：accepted=false，coverage 带"no coverage inventory configured"理由，devBypass/databaseRoles 照常评估完 | ✓ 与 checkpoint 3a 一致 |
| 3b | owned 清单 + 真实受限角色库（三 URL 齐） | **0** | 恰好 1 条 accepted=true 记录 + `BOOT_CONTINUED enabled=true` | ✓ |
| 3c | raw 清单（539 unowned） | **1** | 恰好 1 条记录，uncovered=539 全列 | ✓ |
| 3d | raw 清单 + 豁免 1 条（真实入口 `ALL /*`，带理由） | **1** | 恰好 1 条记录，`waivedEntrances:["ALL /*"]` 留痕，uncovered=538 | ✓ |
| cw | owned 清单 + **损坏 waivers JSON** | **1** | **0 条记录**；stderr = 未捕获 `TypeError: coverage waiver file is not valid JSON` 全栈（`parseWaiverFile` → `evaluateCoverageCheck` → `runMultitenancyStartupChecks`） | **F1 实证** |
| mw | owned 清单 + **缺失 waivers 文件** | **1** | **0 条记录**；stderr = 裸 `ENOENT` 错误对象 | **F1 实证**（同族变体） |
| off | 开关 off | **0** | 仅 `BOOT_CONTINUED enabled=false`，零记录、stderr 空 | ✓ AC1/D2 |

记录形状核验：`{type:"multitenancy-startup-validation", mode:"on", accepted, timestamp, checks:{coverage,devBypass,databaseRoles}}`，coverage 两态均含 `waivedEntrances` ✓。

## 4. Findings（有效发现，含证据）

### F1（medium）— waivers 文件的读取/解析在错误边界之外：损坏或缺失时进程带未捕获异常栈退出，零结构化审计记录

- **位置**：`server/src/enterprise/tenancy/startup-checks.ts:490-491`（`const waivers = waiversPath ? parseWaiverFile(await readTextFile(waiversPath)) : []`）
- **机理**：`evaluateCoverageCheck` 对 inventory 文件的 read/JSON.parse 各有 try/catch 并转成 `ok:false` 理由（463-488 行），但对 waivers 文件的 `readTextFile`（ENOENT）与 `parseWaiverFile` 主动抛出的 `TypeError` 均无 containment——异常穿透 `runMultitenancyStartupChecks` → index.ts 顶层 await 未处理拒绝 → 进程崩溃。同族暴露面：编排器探测循环中 `createDatabase(url)`（约 558-563 行）若同步抛出（如畸形 URL）同样穿透。
- **实证**：§3 cw/mw 两行（本复审独立重放；前任存档 `smoke-corrupt-waivers.jsonl` 0 字节 + `.err` TypeError 栈为交叉对照，结论一致）。
- **违背**：(a) AC3「一条结构化记录可审计」在该输入类上落空——开关状态 on、启动被拒，却无任何审计痕迹，运维只能读 stderr 栈；(b) 模块自身文档契约（`evaluateCoverageCheck` docstring：「任何文件层失败都是校验失败（带理由），绝不冒充通过，也**绝不向上炸进程**」）被同文件内的不对称实现直接否定。
- **不减分项**：fail-closed 方向完好（exit 1，绝无带豁免缺口启动的可能）；豁免纪律本身（typo 拒绝、空理由拒绝）经单测与代码复核均成立。
- **测试缺口**：33 用例中无任何 waivers 文件损坏/缺失穿过编排器的用例（inventory 的两形态有，waivers 的没有）——该缺口正是缺陷存活的直接原因。
- **定级理由**：medium 而非 high——安全语义（拒绝启动）保持，损害面是可审计性契约 + 自述契约失真 + 操作性（裸栈 vs 结构化理由）；亦非 low——AC3 是 Issue #57 四条验收之一，且触发条件是运维合法配置（设了 WAIVERS 路径而文件坏/漏）。

### F2（low）— 新文件携带 biome format 错误，且实现者「新增/自改文件 0 告警」声明与最终工件不符（biome 证据过期）

- **位置**：`server/src/enterprise/tenancy/startup-checks.ts:503-504`——`waivedEntrances: [...evaluation.waivedEntrances],` 与 `};` 缩进 6 空格（应为 8）。
- **实证**：本复审 `bunx biome check`（biome 2.5.10，repo biome.json）五文件 = 8 errors + 1 warning；其中**唯一新增于 HEAD 的发现**即本条 format（HEAD 置换对照见 D3 处置）。第三任复跑日志同为 8+1，互证。
- **根因推断**（证据支持）：该行属晚期「拒绝记录补 `waivedEntrances`」修复（报告 §4 自述冒烟暴露后补）；`verification/biome.txt` 仅记录「Checked 3 files / EXIT=0」，显系修复前旧跑，最终哈希后未重跑 lint。
- **违背**：报告 §3 表「新增/自改文件 0 告警」与 review-package disclosures「biome: new/edited files clean」两处声明对最终态不成立。代码影响本身仅 2 空格缩进（可自动修复），故 low；证据失真单列于此合并处置。

### F3（info）— `parseWaiverFile` 输入硬化不足

- 位置：`startup-checks.ts:157-180`。不校验 waiver 文件自身 `schemaVersion`（接口声明 `schemaVersion:1` 却从不检查，契约漂移与 inventory 侧的严格 schemaVersion 拒绝不对称）；`waivers` 数组元素非对象时（如裸字符串）退化为拒绝消息里出现 `undefined`（方向仍 fail-closed）。无直接单测覆盖其两条 throw 路径。建议随 F1 修复一并处理。

### 未构成发现的核对项（均为 ✓）

- 开关默认关 / on-true-1 / off-false-0 / 垃圾值（含 `ON`、`yes` 等）loadConfig 阶段拒绝——代码 + 155 复跑 ✓；空串按 absent 处理有测试钉住 ✓
- 三校验**全部评估完才 verdict**（不短路）：代码顺序执行三项后合成 `accepted`；3a 记录中 coverage 失败而 devBypass/databaseRoles 仍完整评估 ✓
- 探测只读：唯一语句为 `SELECT pg_roles + pg_has_role`，连接即开即关（`finally closeDatabase`）✓
- 超级用户 setup URL 冒充运行时 URL：真实库用例（33 中第 3 个 describeDb 用例）+ 3b 使用真实受限登录通过 ✓
- off 分支零执行：增量哈希证明（§1）+ smoke-off 零输出 ✓
- RED-1（模块缺失，`Cannot find module`，1 error）/ RED-2（15 fail = 14 新 describe 用例 + 1 条 D1 存量失败，算术自洽）/ MUT1-4（唯一失败数 3/4/3/1，与 README 声明一致；日志中翻倍的 `(fail)` 行系 bun 摘要复列）/ original-hashes 三方一致（`7ab7275e…`）+ restore 后 GREEN——checkpoint 内部一致性核验 ✓（变异重放需改树，超只读复审授权，未执行）
- 启动块位置：`loadConfig()` 之后、`createDatabase(config.databaseUrl)` 与端口读取之前 ✓

## 5. 报告 §5 披露（D1-D7）逐条处置意见

| # | 披露 | 处置 |
|---|------|------|
| D1 | config.test.ts 存量断言修复（`emailPassword:false`） | **核实为真**：`30a04b85` 确为 HEAD 祖先且该提交给 AuthConfig 加 `emailPassword`（git show 复核）；RED-2 的第 15 个失败与之一致。处置得当（补字段 + 注释指源），非越权改行为 |
| D2 | off 模式零审计记录（与 AC1 逐字一致冲突，取后者） | **接受**。AC1 的 byte-identical 在 off 侧与任何新增日志互斥；审计面 = on 记录的 `mode:"on"` + off 即现状本身。与本复审 smoke-off 实证一致 |
| D3 | 存量 lint 7 处（config.ts / index.ts） | **部分核实**：HEAD 置换重跑（本复审独立执行：`git show HEAD:` 两文件 + repo biome.json）得 7 errors + 1 warning，种类与数量（noNonNullAssertion×1 / organizeImports×1 / noConsole×4 / format×2 含 config.ts）与工作树相应发现逐项对应、行号随 27 行增量平移——存量声明**为真**；但「新增/自改文件 0 告警」对最终态**不真**（见 F2），biome.txt 为过期证据 |
| D4 | bun 默认 5s 超时与容器负载，需 60s | **环境事实，接受**；本复审 30s 即全绿（181/11.5s），不构成回退信号 |
| D5 | shared-wiring 共进程干扰，单独跑留证 | **接受**（存量行为；本复审单独运行 3 pass 复现其单独绿） |
| D6 | 真实库用例缺 env 显式 skip | **核实**：无 env 时 5 skip 带理由（RED-restore GREEN 28 pass 即无 env 形态）；终态五变量 env 下 0 skip（本复审复跑 33/0/0）✓ |
| D7 | CoverageInventory type-only import，单一事实源 | **核实**（`import type`，运行时只读 JSON；生产缺工件在 on 模式即拒 = 3a）✓ |

## 6. 结论

MT013 的核心承诺——显式开关默认关 + 关闭零扰动、开启时三校验列全缺口后拒绝启动、恰好一条结构化记录、148 基线零回退——在实现与证据两个层面都站得住，且关键数字（33 / 155 / 181 / 539 / exit 码族）全部经本复审在重建环境上独立复现。**唯一实质缺陷是 F1**：waivers 文件（可选输入）损坏/缺失时错误越过 containment 边界，进程以未捕获栈退出、审计记录缺失——方向仍 fail-closed，但违背 AC3 与模块自述契约，应随后续票据修复（把 waivers 读取/解析并入 inventory 同款 try/catch 降级为 `ok:false` 理由，并补编排器级 waivers 失败用例）；F2 应在修复时顺手 `biome format --write` 并重录 lint 证据。两项均不阻塞本票按检查点受理。

— MT013 独立复审（第五任），2026-10-16（UTC）
