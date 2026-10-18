# MT122 实现任务 — 部署主入口请求上下文（Issue #165）
在 i14-mt122 树（BASE+240 项）实现部署主入口每个 HTTP/内部入口从已认证身份建立请求上下文+作用域工厂取业务依赖。前置 MT014、MT005、MT041 已 verified。

## 验收
- AC1 每个入口建立上下文；缺上下文的业务请求拒绝而非落默认范围（fail-closed，无 default tenant）。
- AC2 业务依赖来自作用域工厂，不来自启动时单份配置（每请求按上下文构造）。
- AC3 上下文建立方式与企业入口、流式入口一致（共享实现，非第三套复制）。
- AC4 普通业务事务不跨外部网络等待（测试或静态检查证据）。

## 交付约束
- 修改面：src/app.ts / src/index.ts 装配（MT030 后版本为底）；startup-checks.ts 若需登记新入口走 globalExceptions 机制（MT030 交付）。
- **谨慎边界**：src/index.ts=6ca171dc、src/app.ts=c18817e3 是共享装配面，改动最小化（只加装配，不重排既有代码——biome 排序除外）；若发现与既有装配冲突，停下 escalate。
- 共享实现=复用既有 enterprise/stream 入口的上下文构造函数（找到它们并消费）。
- AC4 证据：事务内无 fetch/网络调用断言（测试包装或静态扫描存档）。

## 验证
- 端口 55567（库名 w14e），三步配方+七变量 env；基线 990/0/0/38；全量=990+新增；变异自证（默认范围 fail-closed、工厂按上下文、机器上下文拒绝各≥1）；typecheck 0；biome 触及文件 clean（存量口径同 MT030 复审 F1）；checkpoints/MT122/、reports/MT122.md；禁 find /、禁 commit、docker rm 回显。

## 接管注记（第 3 任）
第 1 任未启动即死（零产出）、第 2 任死于 Orca 重启。增量=checkpoints/MT122/（before-hashes/design.md/mutation/provision-db.sh/red-green 至 GREEN-1/verification/test-env.sh）+tests/multitenancy/entry-context.test.ts+装配面改动。从 GREEN-1 后续作（变异/全量/报告未做）。容器已清，自建（端口 55567 或披露换口）。

## 接管注记（第 4 任；2026-10-18 整机重启后）
第 3 任报告 reports/MT122.md 为**中间态**（6 处「待补」：基线 revert 复测/全量 1011 复跑/变异 MUT1-3 实跑+新增 MUT4-5/typecheck/biome——被宿主机过载阻塞）。树内交付与 checkpoints（含 mutation/run.sh 脚本就绪）已就位。本任任务=**补完 6 项待补验证并改写报告为终态**（现在宿主机负载正常）；GREEN-1/链 16/16 已存档勿重做。容器被清，自建。
