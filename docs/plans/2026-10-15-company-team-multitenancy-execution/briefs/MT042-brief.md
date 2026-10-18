# MT042 实现任务 — 平台扫描作用域重建（Issue #85）
在 i14-mt042 树（BASE+240 项）实现平台扫描的到期任务发现与按记录重建作用域执行。前置 MT041 job-ownership 已 verified（lease holder 语义）。

## 验收
- AC1 扫描器列出跨公司到期任务但不读业务内容（列表=元数据，载荷内容不可见）。
- AC2 每项执行前从服务器持久化记录重建 Scope；队列消息里公司/团队字段不被信任（重建=权威行，消息字段仅作路由提示）。
- AC3 机器身份不获得 dev-local-user 或普通用户权限；尝试即拒绝（机器 Scope 与用户 Scope 类型隔离）。
- AC4 反序列化 Scope 被拒；只有签发入口产生的 Scope 有效（MT005 scope-gate 先例：结构≠信任）。

## 交付约束
- 新文件建议：src/enterprise/runs/scan-executor.ts（或 tenancy/ 下同缝）+测试+support。
- 消费 MT041 claimJobLease/finishJobLease（同一 lease 纪律）；消费 MT005 scope-gate 判定。
- 跨公司 deny=canonical not-found 或机器语义明确错误码（不得泄露存在性差异）。
- 冻结面：job-ownership.ts、scope-gate.ts 等既有 verified 文件只消费不改。

## 验证（全项亲测）
- 端口 55564，环境三步配方+七变量 env（同 MT022 brief，库名 w14b）。
- 基线 990/0/0/38 复现；交付后全量=990+新增；变异自证每分支≥1；typecheck/biome 同口径。
- archive/plans/multitenancy-execution/checkpoints/MT042/、archive/plans/multitenancy-execution/reports/MT042.md；禁 find /、禁 commit、docker rm 回显。

## 接管注记（第 2 任）
前任死于 Orca 重启（非工作失败）。树内增量=前任交付：archive/plans/multitenancy-execution/checkpoints/MT042/（before-hashes/design.md 方案已定稿：sweep-read 策略+权威行重建+签发入口+MT041 lease+MT005 gate、mutation/、red-green 到 GREEN-6、verification/、test-env.sh）+tests/multitenancy/scan-executor.test.ts+生产新文件。**先核对树内现态与 red-green 存档链再续作**（不重做已 GREEN 部分）；容器 mt042-impl-pg 已被 coordinator 清除，需自建（端口 55564 若被占换 55568 并在报告披露）。

## 四任接管注记（2026-10-18 05:5x，coordinator 追加）

三任已死于环境重建阶段（~01:56 checkpoint 提交后退出，未发 worker_done）。接手须知：

1. **树上有本地 checkpoint 提交 `3ee2c549`**（含 240 项 prereq 转移+本票实现+全部 checkpoint 证据），`git status` 干净。**不要 reset/amend/revert 该提交**，直接在 HEAD 上继续。
2. 已完成并有落盘证据（`archive/plans/multitenancy-execution/checkpoints/MT042/verification/`）：baseline 990/0/38（01）、全量回归 **1005/0/39**（02，+15 用例）、typecheck exit:0（03）、biome exit:0（05）。冻结面 after-hashes 5 文件哈希已由 coordinator 复核**全部 OK**（无变异残留）。
3. **未完成**（你的全部剩余工作）：
   - mutation 自证（`archive/plans/multitenancy-execution/checkpoints/MT042/mutation/` 目前为空）
   - RESTORE 恢复验证（哈希字节复原）
   - `archive/plans/multitenancy-execution/reports/MT042.md` 报告落盘
   - worker_done（outcome succeeded）
4. 环境：mt042-impl-pg 容器已不存在；三任 10/11 两轮 env 重建失败（port 55564 CONNECTION_CLOSED、step 2b 被 Terminated），失败证据保留在 verification/ 勿删。按三步配方**从零 provision**（container→库→base migrate→十六任务链 apply），不要尝试复用半途状态；若再遇 CONNECTION_CLOSED，先 docker rm 容器重启再来一轮。
5. 结论性数字以你本轮亲跑为准；mutation 结果与 RESTORE 哈希逐个写进 mutation/ 目录与报告。
