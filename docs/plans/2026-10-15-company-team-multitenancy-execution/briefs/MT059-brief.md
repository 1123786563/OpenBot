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

## 四任接管注记（2026-10-18 06:5x，coordinator 追加）

三任已于 01:56 打 checkpoint 提交 `7a46db20`（240 项转移+本票实现+证据），随后在环境重建研究阶段挂死（~05:50 确认），已 stop。接手须知：

1. **勿 reset/amend/revert 提交 7a46db20**，直接在 HEAD 上继续，**零 git 提交**。
2. 已完成落盘（checkpoints/MT059/）：baseline **990/0/38**（verification/03）、RED→GREEN 二轮收敛（RED-GREEN-2nd.txt：修复 visibleWithFacts triple-pinning 第二防线后聚焦 **28/0**，00:19:34）。
3. 三任全量 attempt1/2（verification/20、21）失败定性为**机器负载超时**而非代码缺陷：5000ms 用例超时（MT016 偏好用例等）、attempt2 仅 277 tests/39 文件跑 898s（正常 35s 量级）——当时同机有两票全量+33 常驻容器。**现在 MT042 已结算、其容器已清，请在系统空闲时重跑全量**，期望 **1018/0/39**（990+28）。若个别用例仍超时，先单独复跑该文件三连确认 flaky 再定性。
4. 环境：mt059-impl-pg 已由 coordinator docker rm。从零 provision 时**链序必须用修正版 MT004→MT008→MT112→MT012→…**（MT042 四任已证旧序 MT012 在 MT112 前必失败于全新库；若 provision-db.sh 仍旧序请顺手修正并披露）。
5. 剩余工作：环境从零 provision → 全量回归 1018/0/39 → mutation 自证（mutation/ 目前为空）→ RESTORE 哈希复原 → reports/MT059.md → worker_done outcome=succeeded。
