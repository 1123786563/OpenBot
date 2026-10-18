# MT022 独立复审 brief

角色：独立复审者（**只读复审**——发现问题写进 findings，不修改生产/测试代码）。
对象：MT022 会话消息域（conversation-actions）。树=r14-mt022（BASE f0520524+240 prereq+本票增量 3 文件）。
- 生产：server/src/enterprise/tenancy/conversation-actions.ts
- 测试：server/tests/multitenancy/conversation-messages.test.ts、support/conversation-actions.ts
实现报告：archive/plans/multitenancy-execution/reports/MT022.md；证据：archive/plans/multitenancy-execution/checkpoints/MT022/。

## 必做
1. 环境三步配方从零 provision（库名 openbot_enterprise_r14a_*，端口 55571，七变量 env；链序用 MT004→MT008→MT112→MT012→…→MT070 修正版）。
2. 复跑聚焦套件 conversation-messages.test.ts（实现者：35/0）与全量 `bun test tests/multitenancy/`（实现者：1025/0/39）。
3. 变异抽验：从 mutation/MUT1-8 任选 ≥3 条，重注入→确认聚焦捕获→字节复原（pristine-sha256.txt 为准）。
4. 冻结面核对：240 prereq 哈希 vs prereq-manifest.txt。
## 专项核对（本票特有）
- **D8 披露**：实现者披露套件内存在顺序依赖——核对其定性（哪两用例、什么依赖）是否成立、是否会掩盖缺陷。
- **D6 保守裁定**：Q1/Q2 escalation 20 分钟未答按保守裁定——读 briefs/MT022-brief.md 中 question 存档与实现者的保守处理，判定保守方向是否安全（拒绝而非放行）。
- RED→GREEN 链完整性：RED-0（语法修复）→RED-1→GREEN-1..5 是否真红真绿。
## 输出
archive/plans/multitenancy-execution/reports/MT022-review.md：verdict PASS/FAIL + findings（critical/high/medium/low 分级，各附证据）；结束发 worker_done。
