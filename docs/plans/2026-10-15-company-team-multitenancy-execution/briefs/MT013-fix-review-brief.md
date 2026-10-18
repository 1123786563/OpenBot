# MT013 / Issue #57 修复轮增量复审 Brief — coordinator 下发

你是 MT013 修复轮的独立复审者（全新 Pi 会话，与实现者/修复者/原复审者无共享上下文）。只读被审文件；唯一允许新建文件 = reports/MT013-fix-review.md；不修复；无提交/推送/合并授权；skipped 不算通过。完成 worker_done 附 --report-path。

## 背景

原交付复审（`reports/MT013-review.md`，第五任，sha256 a734f15e…，保留在本树）判定 PASS 带 1 medium（F1）+ 1 low（F2）+ 1 info（F3）。coordinator 裁决 #11 触发修复轮：修复交付 = `startup-checks.ts` 7ab7275e→**59f7e658**、`startup-checks.test.ts` 2d030bf2→**f30dbc2a**（领取时先核实现树快照哈希）+ `checkpoints/MT013/fix/` 全套 + 报告修复轮章节（reports/MT013.md 尾部）。修复指令原文见 `briefs/MT013-fix-brief.md`。

## 审阅对象与重点裁决

1. **F1 修复语义（medium 消除）**：waivers readTextFile（ENOENT）/parseWaiverFile（TypeError）与 createDatabase 同步抛出全部 containment——验证 (a) 失败降级为 coverage/databaseRoles `ok:false` 结构化理由而非 reject/崩溃；(b) 三校验仍全部评估不短路；(c) 审计记录恰好一条；(d) fail-closed exit 1 方向不变；(e) createDatabase 理由不回显 URL（口令防泄漏）；(f) containment 未误伤通过路径（冒烟 ok 正控制）。
2. **改动面最小性**：`fix/changes.diff` vs 修复指令——只动两授权文件；`fix/before-hashes.txt` = 原复审时快照哈希（7ab7275e/2d030bf2）逐字节核对。
3. **测试增量纯加法**：startup-checks.test.ts 原有 33 用例未被动（diff 层面只加不改；41=33+8）；8 新用例逐条对应 F1（3：损坏/缺失/工厂抛出）+ F3（5：schemaVersion/非对象/非数组/元素非对象/合法 guard）。
4. **TDD 真实性**：RED-1（5 fail 含脚手架 bug 诚实披露）→ RED-2（对回退至 7ab7275e 的原实现重跑，运行前哈希验证，5 fail 恰为新增用例）→ GREEN 41/0/0。核验 RED-2 存档中原实现哈希声明与 before-hashes 互证。
5. **F2**：`fix/verification/5-biome.txt` 重录（两自改文件 0 告警 EXIT=0；存量 7+1 维持——与原复审 F2/D3 的 8+1 对照，新增 format 错误应消失）。
6. **F3**：parseWaiverFile schemaVersion===1 对称拒绝、元素拒绝消息带索引与类型、无 `undefined`；5 例单测存在且真实驱动 throw 路径。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55475`；专用容器 mt013-fixrv-pg（pgvector/pgvector:pg16，trust，psql 探针就绪勿只用 pg_isready）；五变量 URL 显式用户 + 三登录随机口令 0600 env 用后删；`enterprise-test-db.ts migrate` + `migrate-test.ts migrate MT004 --apply`（前置）。
2. `bun test tests/multitenancy/startup-checks.test.ts --timeout 30000`（预期 **41/0/0skip**，119 断言）
3. `bun test tests/config.test.ts`（预期 155/0）
4. 全量 `MT003_ASSIGNED_TEST_DATABASE_URL=… bun test tests/multitenancy/ --timeout 30000`（预期 **189/0/0skip** = 181+8）
5. `cd server && bun run typecheck`；`bunx biome check` 两自改文件（预期 0）
6. **冒烟重放**（boot-slice：按报告 §修复轮 boot-slice 方式或自行等价构造）：cw（损坏 waivers）→ exit 1 + 恰好 1 条结构化记录 + **stderr 零行无栈**；mw（缺失）→ 同上含 ENOENT；ok（合法空豁免）→ exit 0 + BOOT_CONTINUED + 1 条 accepted 记录。这是 F1 消除的终局证据。
7. 清理容器与凭据。

## 结论要求

逐条判定 F1/F2/F3 是否消除（原 finding 复核 + 新缺陷扫描）；Verdicts + findings + 命令退出码。若发现新 critical/high/medium 如实报告（不预设结论）。
