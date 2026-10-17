# MT059 实现任务 — 用户私有 Bot（Issue #102）
在 i14-mt059 树（BASE+240 项）实现每位用户每团队范围的私有 OpenMuse Bot。前置 MT016 bot-ownership、MT014 runtime-config 已 verified。

## 验收
- AC1 同一(公司,团队,用户)重复请求幂等得同一私有 Bot（不产生重复记录——幂等键=三元组）。
- AC2 同一用户在两个公司分别独立私有 Bot，数据互不可见（跨公司 deny=canonical not-found）。
- AC3 模板升级只更新模板管理字段，用户自定义字段保留（对照测试：升级前后用户字段逐位不变）。
- AC4 私有 Bot 不出现在团队列表/团队搜索。

## 交付约束
- 新文件建议：src/enterprise/tenancy/personal-bot.ts+tests+support；消费 MT016 bots-ownership 判定缝。
- 模板字段管理=字段级所有权表（模板管理字段集合 vs 用户字段集合显式清单，不靠约定）。
- 冻结面：bots-ownership.ts、runtime-config.ts 只消费不改。

## 验证
- 端口 55566（库名 w14d），三步配方+七变量 env；基线 990/0/0/38；全量=990+新增；变异自证（幂等键、字段所有权、跨公司隔离各≥1）；typecheck/biome；checkpoints/MT059/、reports/MT059.md；禁 find /、禁 commit、docker rm 回显。

## 接管注记（第 2 任）
前任死于 Orca 重启。增量=checkpoints/MT059/（before-hashes/mutation/red-green 至 RED-1 模块缺失型/verification）+tests/multitenancy/openmuse-private-bot.test.ts。RED-1 已存档=测试先行完成，从 GREEN 阶段续作。容器已清，自建（端口 55566 或披露换口）。
