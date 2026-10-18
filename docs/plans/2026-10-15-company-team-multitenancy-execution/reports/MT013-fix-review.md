# MT013 / Issue #57 — 修复轮增量复审报告（裁决 #11 三 findings 消除验证）

- 复审者：第六任独立 Pi Reviewer（Dispatch `ctx_6f4b3c86b05a`，Task `task_3f3c19fd1f1a`；与前五任无共享上下文）
- 被审交付：修复轮报告 `reports/MT013.md` 尾部「修复轮」章节（sha256 `634a559a…`，manifest 复算一致）+ `checkpoints/MT013/fix/**`
- 领取快照核验：工作树 `startup-checks.ts` = **`59f7e658…`**、`startup-checks.test.ts` = **`f30dbc2a…`**（与裁决 #11 下发哈希逐字节一致）；git HEAD `f0520524…` 与原复审 BASE 相同
- 复审方式：只读被审文件；全部关键断言在**新建专用容器**上独立复跑（非沿用修复者状态）；复跑产物留存 `/tmp/mt013fixrv/`；唯一写入仓库文件 = 本报告

## Verdicts

| 项 | 结论 |
|----|------|
| **F1（medium）waivers/createDatabase 异常 containment** | **消除 ✓**（六点语义全部实证，见 §2） |
| **F2（low）biome format + 证据重录** | **消除 ✓**（独立重跑两自改文件 EXIT=0；存量 7+1 维持） |
| **F3（info）parseWaiverFile 输入硬化** | **消除 ✓**（schemaVersion 对称拒绝、索引+类型消息、5 例 throw 路径单测全数真驱动） |
| 改动面最小性 | ✓ 仅两授权文件；before-hashes 与原复审快照逐字节互证 |
| 测试纯加法 | ✓ diff 零删除行；41=33+8；8 新用例精确对应 F1×3+F3×5 |
| TDD 真实性 | ✓ RED-1（含脚手架 bug 诚实披露）→ RED-2（原实现重跑，哈希声明与栈行号双重互证）→ GREEN |
| **修复轮总评** | **PASS**（无新增 critical/high/medium/low；3 条 info 级备注，见 §5） |

## 1. 快照与改动面核验（亲自执行）

- **fix manifest 复算**：`fix/sha256-manifest.txt` 24/24 一致（deliverables 2 + fix checkpoints 21 + 报告 1；报告哈希 `634a559a…` 独立复算吻合）。
- **diff 往返闭合**：把 `fix/changes.diff` 对当前工作树反向 apply → 产物 sha256 = `7ab7275e…` / `2d030bf2…`，与 `fix/before-hashes.txt` 及**原复审（第五任）快照哈希**三方逐字节一致——before 态即原复审所审终态，无中间偷改。
- **改动面最小性**：diff 恰好触及两授权文件；impl 侧四 hunk 与修复指令一一对应（F3 硬化 / F1 waivers containment / F2 缩进 6→8 / F1 createDatabase containment），无越权改动。
- **首轮 manifest 回照**：首轮 `sha256-manifest.txt` 对当前树复算 31 OK + 5 失配，失配全部为预期形态——两修复文件本身（授权变更）、两份 manifest 自引用（首轮复审已披露的已知形态）、报告路径基准差（报告哈希已单独验证）。**结论：修复轮之外的一切交付文件逐字节未动。**

## 2. F1 消除验证（六点语义，逐点实证）

| # | 语义 | 证据 |
|---|------|------|
| (a) | 失败降级为 `ok:false` 结构化理由而非 reject/崩溃 | 冒烟 cw 记录：coverage `ok:false`，reason = `coverage waiver file could not be read or parsed (<path>): coverage waiver file is not valid JSON: …`；mw 含 `ENOENT: no such file or directory, open '<path>'`。编排器单测（损坏/缺失两例）断言不 reject |
| (b) | 三校验仍全部评估不短路 | cw/mw 记录中 devBypass `ok:true`、databaseRoles `ok:true`（真实受限角色库实际探测）；单测显式断言两项照常完成 |
| (c) | 审计记录恰好一条 | 三变体 stdout `multitenancy-startup-validation` 记录数 = 1/1/1（grep 计数）；单测断言 verdict 恰 1 条日志 |
| (d) | fail-closed exit 1 方向不变 | cw/mw exit=1、accepted=false；ok 正控制 exit=0 |
| (e) | createDatabase 理由不回显 URL | 代码只插值 `error.message`（`database factory threw before connecting: …`），模板无 url；实测 postgres 驱动畸形 URL 抛出消息不含口令（注入 S3CRET 探针，leaks=false） |
| (f) | containment 未误伤通过路径 | ok 变体（合法空豁免）：exit 0 + `BOOT_CONTINUED multitenancy=true` + 1 条 accepted=true 记录，coverage `waivedEntrances:[]` |

冒烟 stderr：cw/mw/ok 三变体 **0 字节 0 行无栈**（原复审实证的「stdout 0 记录 + stderr 全栈」形态消除）。原复审 cw/mw 变体重放矩阵与本轮逐项对合。

## 3. 独立复跑（全部亲自执行，命令与退出码）

环境：容器 `mt013-fixrv-pg`（pgvector/pgvector:pg16 @127.0.0.1:55475，trust，PostgreSQL 16.15；端口预检 `lsof -i :55475` 空闲；psql 探针第 4 次通过）；`openbot_enterprise_test`（enterprise-test-db.ts migrate + ent_mt013rv_{dir,data,opr} 受限 LOGIN 随机口令 + MT004 generate→--apply 门禁应用）+ `openbot_enterprise_mt013rv_assigned`（全新）；五变量 URL（显式用户）0600 env 用后删；角色形态复核：三登录各恰持一个 `ob_ent_*` 成员资格、能力角色 NOLOGIN、登录非 super ✓。工件重产：raw 清单 **539 入口/539 unowned/23 closures**（与原复审独立重现同源）；owned 清单 **539/0/0，digest `a823637d…`**（与修复报告声明一致）。

| # | 命令 | 退出码 | 结果 |
|---|------|--------|------|
| 1 | `bun --no-env-file scripts/enterprise-test-db.ts migrate` | 0 | `migrations-applied ok` |
| 2 | `migrate-test.ts generate MT004 --out …` + `migrate MT004 --apply --manifest …` | 0 | 2 步 15 语句入 journal |
| 3 | `bun --no-env-file test tests/multitenancy/startup-checks.test.ts --timeout 30000`（五变量 env） | 0 | **41 pass / 0 fail / 0 skip，119 断言** |
| 4 | `bun --no-env-file test tests/config.test.ts` | 0 | **155 pass / 0 fail** |
| 5 | `bun --no-env-file test tests/multitenancy/ --timeout 30000`（+ MT003_ASSIGNED） | 0 | **189 pass / 0 fail / 0 skip**（= 181+8） |
| 6 | `cd server && bun run typecheck` | 0 | tsc --noEmit 干净 |
| 7 | `bunx biome check` 两自改文件 | **0** | Checked 2 files，**0 告警** |
| 8 | `bunx biome check` 存量三文件（config.ts / index.ts / config.test.ts） | 1 | **7 errors + 1 warning**（与披露逐项一致：config format；index noConsole×4/noNonNullAssertion/organizeImports/format） |
| 9 | 冒烟 boot-slice（工作树 config.ts + startup-checks.ts，与 index.ts 启动段接线同构） | cw=1 mw=1 ok=0 | §2 表；stderr 三变体 0 行 |

注 1（第 3 行首次跑 36 pass + 5 skip）：系本复审 env 漏设 `ENTERPRISE_TEST_SETUP_DATABASE_URL`（`probeEnvironment` 的 required 列表同时要求 SETUP 与 TEST_DATABASE_URL 两个变量名）——复审侧环境错误，补设后 41/0/0；非被审缺陷，仅记录 env 契约的这一不对称。
注 2（第 5 行断言数 7438 vs 存档 7435）：pass/fail/skip 计数完全一致，断言数差 ±3 来自分支依赖（如 membership-model criterion-4 的 applied/up-to-date 双分支），非回退信号。
清理：容器移除、凭据文件删除、端口释放，均确认。

## 4. F2 / F3 / TDD 核验

- **F2**：独立重跑 biome——两自改文件 EXIT=0 零告警；存量 7+1 与原复审 F2/D3 的 8+1 对照：唯一新增项（startup-checks.ts:503-504 缩进 format 错误）已随 6→8 空格修复消失。`fix/verification/5-biome.txt` 重录内容与本次独立结果一致。
- **F3**：(a) `schemaVersion===1` 拒绝（消息与 inventory 侧同款 `has schemaVersion N, expected 1`）；(b) 顶层非对象/waivers 非数组/元素非对象三类均响亮拒绝，元素消息带索引与类型（`waivers[0] … got a string`、`waivers[1] … got null`），消息无 `undefined`；(c) 5 例单测存在且真驱动 throw 路径——RED-2 对未硬化原实现重跑时 schemaVersion/元素两例如约 fail（原实现不抛），证明测试确实咬住硬化行为；合法文件 guard 不误伤。
- **TDD 真实性**：
  - RED-1：5 fail = 4 缺陷信号 + 1 测试脚手架 bug，头部注释诚实披露且签名自洽（createDatabase 用例 "Expected false / Received true" 正是判别式 `url.includes("directory")` 不命中 fixture URL 的形态）；
  - RED-2：存档头部声明回退至 `7ab7275e…`（运行前 sha256 验证）——与 before-hashes 及本复审反向 patch 复现三方互证；栈行号（parseWaiverFile:169 / evaluateCoverageCheck:491 / runMultitenancyStartupChecks:523 / createDatabase:560）与原实现布局（原复审引 490-491、约 558-563）吻合，进一步佐证运行对象确为原实现；5 fail 恰为新增用例（8 中咬缺陷的 5 个），原 33 用例零失败，31 pass + 5 skip + 5 fail 算术自洽；
  - GREEN：41/0/0 skip（119 断言）经本复审独立复跑确认（见 §3 行 3）。

## 5. Findings（新缺陷扫描）

**无新增 critical/high/medium/low。** 三条 info 级备注（均不阻塞受理）：

- **N1（info）**：`fix/red-green/GREEN-unit-41tests-0skip.txt` 存档不完整——仅头部两行 + bun 版本行，无测试正文与 41-pass 摘要（疑重定向截断）。实质证据无损：`fix/verification/3-full-regression-189pass-0skip.txt` 含全部 41 用例逐条 (pass) 且 0 skip（本复审逐名核对 8 新用例在内），且独立复跑吻合。建议后续检查点归档时校验文件尾部摘要行存在。
- **N2（info）**：全量回归断言计数在复审环境为 7438 vs 存档 7435（计数与通过/跳过完全一致；分支依赖差异，见 §3 注 2）。
- **N3（info）**：豁免元素为对象但缺字段（如 `{}`）时，evaluator 的 typo 拒绝消息仍会出现字面 `undefined`（`entrance` 为 undefined 进入 unknown-waivers 列举）——该输入类不在 F3 修复指令范围（指令仅覆盖"元素非对象"），方向 fail-closed、纯观感问题，且为首轮既有行为，非本轮引入。留作后续票据可选打磨。

## 6. 结论

裁决 #11 三 findings（F1 medium / F2 low / F3 info）**全部消除**：waivers 与 createDatabase 的文件/URL 层异常已并入 inventory 同款 containment，从「裸栈 + 零审计记录」变为「恰好一条结构化记录 + exit 1 + stderr 零行」，通过路径（ok 正控制）不受误伤；format 错误清零且证据重录与独立重跑一致；parseWaiverFile 输入硬化到位并有真实 RED 支撑。改动面严格限于两授权文件（往返哈希闭环 + 首轮 manifest 回照双重证明），测试纯加法（41=33+8），全绿门槛（41/0/0、155/0、189/0/0、typecheck 0、biome 自改 0/存量 7+1）在本复审新建容器上全部独立复现。**修复轮受理，MT013 可按检查点归档推进。**

— MT013 修复轮增量复审（第六任），2026-10-16（UTC）
