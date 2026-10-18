# MT021 修复轮执行计划（brief：briefs/MT021-fix-brief.md）

角色：backend_implementer 第 2 任（接管注记：第 1 任死于规划期，零增量，全新执行）。

## Findings → 修复动作

- **F1（high）游标键微秒精度丢失**：游标键源改为 SQL 侧 `created_at::text`
  （列表查询 select 增加 createdAtText 计算列，`at` 字段存该文本形态；下一页
  谓词保持 `(created_at, id) > (at::timestamptz, id)`——MT016 bots-ownership
  既有模式）。补用例：夹具新增显式 `::timestamptz` 字面量种子通道
  （createdAtText），两条新用例断言微秒形态下翻页收敛/不跳不重/游标 `at`
  携带微秒。
- **F2（low）at 非时间戳的游标**：decodeCursor 增加 `at` 时间戳形状校验谓词
  （PG text 形态 + ISO-8601 均接受），结构合法但非时间戳的令牌在 decode 时
  落入 CONVERSATIONS_CURSOR_INVALID；补一条拒绝用例。
- **F3（low）pristine 哈希证据卫生**：修复轮 pristine 快照取在 biome 收尾之
  后（mutation/pristine-sha256.txt == 交付终态 a7d5820b…），实现轮的
  pre-biome 记录（5b6ed95f…）被取代并披露。

## 门槛复验清单

- [x] 前像哈希冻结（before-hashes.txt，==复审终态 38fb0267/5a89bbb2/a028f792）
- [x] RED：3 条新用例全失败（26 pass / 3 fail），F2 失败形态=裸驱动错误
- [x] GREEN：29 pass / 0 fail / 0 skip（26+3）
- [x] 全量 799 pass / 0 fail / 30 文件 / 0 skip（796+3）
- [x] typecheck（tsc --noEmit）exit 0
- [x] biome 触及 3 文件 0 错误（首跑 1 格式错自欠，修正后复检 clean 存档）
- [x] MUT3 复验：注入后 6 fail / 23 pass（实现轮 4 → 修复轮 6，含新 F1 用例），
      还原哈希==pristine==交付终态，复绿 29/0/0
- [x] 十四任务链真实执行（01-base-migrate / 02-chain-apply，journal 14 任务 28 步）
- [x] 容器 mt021-fix-pg @ 55539（预检 FREE 无 +1），七变量 env 0600，用后删
- [x] 范围纪律：全树 diff 实证仅 3 交付文件变更（fix.diff 257 行）
- [ ] docker rm -f 真实执行回显存档
- [ ] 报告附记（本文件归档后执行）
