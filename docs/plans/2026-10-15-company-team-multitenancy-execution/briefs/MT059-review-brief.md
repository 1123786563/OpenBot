# MT059 独立复审 brief

角色：独立复审者（**只读复审**——发现问题写 findings，不改代码；本票有下述特例验证操作）。对象：MT059 用户私有 Bot。树=r14-mt059（BASE+240+增量 7 文件）。
- 生产：server/src/enterprise/tenancy/personal-bot.ts（**工作树态=HEAD+MUT-1 移除**）、server/src/db/schema/enterprise-personal-bot.ts、schema/index.ts、migrate-test.ts（窄缝）
- 测试：openmuse-private-bot.test.ts（28 用例）、support/personal-bot.ts、migration-tool.test.ts
实现报告：reports/MT059.md（四任）；证据：checkpoints/MT059/。

## 背景必读
四任发现 checkpoint 提交 7a46db20 内 personal-bot.ts **残留活体变异 MUT-1**（三任注入后死亡），已移除（工作树 diff −33/+1）。复审树以工作树态为准；「移除是否干净」是本复审第一专项。

## 必做
1. 三步配方 provision（库名 openbot_enterprise_r14e_*，端口 55575；链序修正版）。
2. 聚焦 openmuse-private-bot.test.ts（28/0/125 expect）+全量（1018/0/39）。
3. 冻结面核对（before-hashes.txt：bots-ownership/runtime-config 逐字节一致）。
## 专项核对
- **MUT-1 移除干净度**：读 git diff（相对本树 checkpoint 提交）确认幂等分支还原为「重复请求返回既有行、不推进 revision」；再自行注入一次 MUT-1 同形变异（重复请求推进 revision+消费新输入）确认聚焦捕获（AC1 用例变红），随后字节复原。此项允许改码但必须复原并落盘 diff 证据。
- **AC1 三元组幂等**： 首建一行+重复全同+模板冲突响亮拒绝用例存在且真实。
- **AC3 字段所有权**：升级前后用户字段逐位不变的对照断言；升级前模板字段名不可侵占用户字段。
- **AC2 隔离**：跨公司=MT011 canonical not-found 逐字节同形；同公司跨团队不可见（三元组钉住）。
- **AC4 不进团队面**：结构性证明（私有 Bot 从未写入 enterprise_bot_ownership/发布注册表）+团队列表计数对照。
- **MUT-2 披露复核**：四任披露首选变异（去 userOwnedNames 过滤）因字段名不相交而不可捕获——复核该披露是否属实（模板字段 vs 用户字段名空间）。
## 输出
reports/MT059-review.md：verdict+分级 findings；worker_done。
