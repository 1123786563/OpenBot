# MT042 独立复审 brief

角色：独立复审者（**只读复审**）。对象：MT042 平台扫描执行器。树=r14-mt042（BASE+240+增量 5 文件）。
- 生产：server/src/enterprise/runs/scan-executor.ts（639 行）、server/scripts/multitenancy/migrate-test.ts（窄缝）
- 测试：scan-executor.test.ts（**含四任修复 +12/−7**）、support/scan-executor.ts、migration-tool.test.ts
实现报告：reports/MT042.md（四任）；证据：checkpoints/MT042/（三任 00-11+四任 12-20+mutation/）。
注意：本票四任历史复杂（三任死于环境重建），报告 §3 有 5 条诚实披露。

## 必做
1. 三步配方 provision（库名 openbot_enterprise_r14d_*，端口 55574；**链序 MT112→MT012 修正版**——provision-db.sh 若仍旧序先修再跑并披露）。
2. 聚焦 scan-executor.test.ts（四任：15/0）+全量（1005/0/39）。
3. 变异抽验：MUT1-12 任选 ≥4 条（**必含 MUT10 签发入口旁路+MUT12 拒绝理由回显**）重注入→捕获→复原。
4. 冻结面 5 文件 vs checkpoints/MT042/after-hashes.txt。
## 专项核对（票面安全核心）
- **机器身份（AC3）**：MachineScanIdentity 是否结构性不可冒充用户（dev-local-user 拒绝、principal 仿冒拒绝、用户 scope 驱动扫描拒绝）——至少核对聚焦套件四个拒绝用例真实存在且断言到点。
- **反序列化 Scope（AC4）**：JSON round-trip/structuredClone 副本一律 UNVERIFIED_SCOPE——核对用例存在且覆盖 clone 机器身份。
- **AC2 权威行重建**：伪造 tenant/workspace/principal 提示不影响权威行执行；payload 字段结构性不进入扫描面（AC1：RETURNING 列白名单）。
- **披露①复核**：四任对 scan-executor.test.ts 的 +12/−7 修复（executorRecording 实参错位）——git diff 树内 vs HEAD 确认改动面与披露一致，无夹带。
- **披露③链序修正**：provision-db.sh MT112→MT012 修正是否与 MT041 报告存档链序一致。
- **历史存档分裂**：三任 GREEN-1/3 与 GREEN-2/4 对 AC1 用例 pass/fail 记录分裂——确认四任「实参错位必红」的解释闭环（修复后该用例确定性绿）。
## 输出
reports/MT042-review.md：verdict+分级 findings；worker_done。
