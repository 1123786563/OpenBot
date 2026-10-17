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
- checkpoints/MT042/、reports/MT042.md；禁 find /、禁 commit、docker rm 回显。

## 接管注记（第 2 任）
前任死于 Orca 重启（非工作失败）。树内增量=前任交付：checkpoints/MT042/（before-hashes/design.md 方案已定稿：sweep-read 策略+权威行重建+签发入口+MT041 lease+MT005 gate、mutation/、red-green 到 GREEN-6、verification/、test-env.sh）+tests/multitenancy/scan-executor.test.ts+生产新文件。**先核对树内现态与 red-green 存档链再续作**（不重做已 GREEN 部分）；容器 mt042-impl-pg 已被 coordinator 清除，需自建（端口 55564 若被占换 55568 并在报告披露）。
