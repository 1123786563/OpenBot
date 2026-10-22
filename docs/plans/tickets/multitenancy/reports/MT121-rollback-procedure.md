# MT121（Issue #164）：多租户上线与回退程序（含演练记录）

> 单一事实源：`server/src/enterprise/tenancy/rollback-procedure.ts` 的
> `MULTITENANCY_ROLLBACK_PROCEDURE`（程序五步与判定条件逐字来自该表，
> 本文档不另立第二份叙述）。可自动化判定入口：`evaluateRollbackGate`
> （回退门）与 `runRollbackDrill`（演练驱动器）。复现命令：
> `bun test server/tests/multitenancy/rollback-procedure.test.ts`。
> 本票不执行生产迁移或部署；生产备份/恢复的人工命令面（pg_dump/
> pg_restore）在步骤 2/3 注明。

## 程序五步（顺序即执行顺序；判定条件不过不进下一步）

### 1. 冻结写入（freeze-writes）

- **判定条件**：持有的 job lease 数 = 0 且活跃事件订阅数 = 0
  （`evaluateRollbackGate` 的停止前置半边）；业务入口停止对外服务
  （部署层动作，判定面是上述两个可数事实归零）。
- **执行面**：停止业务入口与任务执行（部署层）；判定入口
  `evaluateRollbackGate` 的 `stopFirstSatisfied`。

### 2. 备份（backup）

- **判定条件**：租户域十六表逐表行数 + 内容摘要（md5 全表稳定投影）
  落盘成备份清单；清单缺任一存在表即不通过。
- **执行面**：生产 `pg_dump`（对象库 + 主库全套，含 RLS 策略与
  GRANT——`--section=post-data` 必须在内）；演练用
  `runRollbackDrill` 的 backup 步（库内逐表 digest）。

### 3. 恢复（restore）

- **判定条件**：恢复目标上重算同一摘要算法，逐表与备份清单一致；
  任一表行数或摘要不一致即失败隔离该表。
- **执行面**：生产 `pg_restore`；演练用 restore 步（影子模式
  `mt121_drill_restore` 真实物化后对照——数据搬运，不是纸面对照）。

### 4. 失败隔离（failure-isolation）

- **判定条件**：按租户逐表枚举行：归属列非空的每一行都落在恰好一个
  租户（零 NULL 归属残留）；失败租户的行集合可被完整圈出而不触碰
  他租户行。
- **执行面**：`runRollbackDrill` 的 failure-isolation 步（逐租户行枚举）。
  失败租户的处置走 MT120 隔离清单（`quarantine-list.ts`）——归属或
  销毁，不按猜测分配。

### 5. 回退门（rollback-gate）

- **判定条件（两条硬规则，AC3）**：
  1. 可归属业务表（enterprise_resources / enterprise_conversations /
     enterprise_bot_ownership）中的公司数 ≤ 1 才允许回退到不理解归属
     的旧版本；**存在多公司数据 ⇒ 必须使用仍支持隔离的版本**（拒绝
     回退，不是警告——旧版本无法按公司/团队解析这些行，回退即破坏
     隔离事实）。
  2. 冻结前置未满足（仍有持有的 job lease 或活跃事件订阅）⇒
     **必须先停止业务入口与任务执行**——否则回退在飞行写入中途截断。
- **执行面**：`evaluateRollbackGate`（生产与演练共用同一判定；两条
  拒绝理由一次列全）。

## 回退路径裁决（AC3）

| 局面 | 必须怎么做 |
| --- | --- |
| 多公司数据已存在 | **不能**回退到不理解归属的旧版本；使用仍支持隔离的版本（或前滚修复） |
| 单公司数据、飞行事实已清零 | 可回退（先走完步骤 1–4） |
| 飞行事实未清零（lease/订阅在飞） | 先停止业务入口与任务执行，再回退 |

## 演练记录（AC2：实测输入，不是承诺）

在专用测试库 `openbot_enterprise_mt22`（容器 orca-w3-mt-pg，
pgvector/pg16，127.0.0.1:5565）执行，2026-10-22T04:35:11Z：

| 步骤 | 耗时 (ms) | 数据量 | 判定 |
| --- | --- | --- | --- |
| freeze-writes | 7 | lease 0、活跃订阅 0 | pass |
| backup | 7 | 16 表在场 / 1012 行 / 缺表 0 | pass |
| restore | 93 | 16 表影子物化 / 不一致 0 | pass |
| failure-isolation | 1 | 3 可归属表 / 单公司 / NULL 归属行 0 | pass |
| rollback-gate | 1 | allowed=true（演练时点单公司） | pass |

**遇到的问题（AC4：发现即修即重验）**：演练记录 problems=[]；开发过程
中演练测试在全目录轮之后暴露一个可修复问题——全表摘要（16 表
string_agg md5）随共享库残留行增长超过 bun test 默认 5s 超时（实测
8–12s），测试被硬杀导致影子模式清场被跳过。修正：两个演练测试给出
60s 超时上限（itDb 透传超时参数），重验 6/6 绿且影子清场断言恢复。演
练时点该库只有锚点公司持有可归属业务行，回退门如实判定 allowed=true；
多公司与停止前置两个拒绝半边由测试以种子数据钉死（AC3 三例）。

**停机窗口说明**：上表的耗时是判定与影子物化的实测，不是生产停机窗口
的承诺——生产窗口 = 步骤 1 的入口停止 + 步骤 2 的 pg_dump 全量时长
（数据量依赖）+ 步骤 3 的恢复时长，须在演练环境按真实数据量实测后
写入变更单。

## 演练发现问题的修正（AC4）

本轮演练未发现问题（problems 为空）；测试套件对逐步判定与影子清场
（演练后 `mt121_drill_restore` 模式必须不存在）持续钉死，后续演练发现
的问题按「修正 + 重验 + 记录于此」闭环。
