# MT013 / Issue #57 修复轮 Brief — coordinator 下发（裁决 #11）

你是 MT013 的修复实现者。独立复审（第五任，reports/MT013-review.md，sha256 a734f15e…）判定 PASS 带 1 medium + 1 low + 1 info。按裁决 #11 修复以下三项，TDD（先 RED 后 GREEN），交付未提交检查点。

## F1（medium，必须修）— waivers 错误越过 containment 边界

- 位置：`server/src/enterprise/tenancy/startup-checks.ts:490-491`。`evaluateCoverageCheck` 对 inventory 文件的 read/parse 已有 try/catch 降级为 `ok:false` 理由（463-488 行范式），但 waivers 的 `readTextFile`（ENOENT）与 `parseWaiverFile` 的 `TypeError` 无 containment——穿透 `runMultitenancyStartupChecks` → 进程裸栈崩溃 + **零结构化审计记录**（AC3 违反 + docstring「绝不向上炸进程」自述契约破坏；复审 §3 cw/mw 实证：损坏/缺失 waivers → exit 1、stdout 0 条记录、stderr 栈）。
- **修法**：把 waivers 读取与解析并入 inventory 同款 try/catch——失败降级为 coverage `ok:false` 带结构化理由（如 `waiver file unreadable/invalid: <原因>`），三校验照常全部评估，记录照常恰好一条，`accepted=false`，exit 1。方向 fail-closed 不变，只是从「裸崩溃」变「结构化拒绝」。
- **同族（一并修）**：复审指出的编排器探测循环 `createDatabase(url)`（约 558-563 行）同步抛出（如畸形 URL）同样穿透——同样 containment（降级为 databaseRoles `ok:false` 理由），不要让任何文件/URL 层异常穿透模块边界。
- **补测试**：编排器级（`runMultitenancyStartupChecks`）waivers 损坏、waivers 缺失两用例（断言：恰好一条记录、coverage ok:false 带理由、不 reject、devBypass/databaseRoles 仍评估）——此缺口正是缺陷存活原因（33 用例无覆盖）。

## F2（low，顺带修）— biome format + 证据重录

- `startup-checks.ts:503-504` 缩进 6 空格应为 8（`waivedEntrances` 行与 `};`）。`bunx biome check --write` 或手改后**重录** `verification/biome.txt`（旧文件是修复前过期证据——复审 F2 实证 8 errors+1 warning 中唯一新增项即此 format 错误）。

## F3（info，随 F1 修）— parseWaiverFile 输入硬化

- `startup-checks.ts:157-180`：(a) 校验 waiver 文件 `schemaVersion===1`（接口声明却从不检查，与 inventory 侧严格 schemaVersion 拒绝对称）；(b) 数组元素非对象时拒绝消息不再出现 `undefined`（给出元素索引与类型）；(c) 两条 throw 路径补单测。

## 约束与验收

- 只改 `server/src/enterprise/tenancy/startup-checks.ts` 与 `server/tests/multitenancy/startup-checks.test.ts`（如 F3 需要可微调 tests/config.test.ts 并披露）；其余交付文件不动。
- 修复后全绿门槛：startup-checks 套件 33+新增全过 0 skip（五变量 env 真实库）；config 155/0；全量 `tests/multitenancy/ --timeout 30000` = 181+新增/0/0skip（本树 MT005-era 基线，勿与 EXE 232 混淆）；typecheck 0；biome 五触及文件「新增/自改 0 告警」（存量 7+1 披露维持）。
- 专用库 pgvector/pgvector:pg16（端口 55473，容器名 mt013-fix-pg，psql 探针就绪；base migrate + MT004 apply 前置；五变量 URL 显式用户 + 随机口令 0600 env 用后删）。
- boot-slice 冒烟重放 cw/mw 两变体证明「结构化记录一条 + exit 1 + 无栈」。
- 交付：reports/MT013.md 追加「修复轮」章节（TDD 序列、前后哈希、证据）+ checkpoints/MT013/ 追加 fix/ 子目录（changes.diff、red-green/、verification/biome.txt 重录）。完成后 worker_done 附 --report-path。无提交/推送/合并/生产迁移/部署授权。
