# MT022 实现任务 — 会话生命周期权限（Issue #65）
在 i14-mt022 树（BASE f0520524+prereq 240 项）实现会话内消息发送/读取/重命名/归档/历史 replay 的作用域授权。前置 MT021 conversations-list 已 verified（cursor 分页、created_at::text 计算列先例）。

## 验收（逐条 TDD 钉死）
- AC1 非成员不能读写会话消息；不能通过历史 replay 绕过（replay=独立授权面，不是读的别名）。
- AC2 重命名与归档分别授权；可读不派生可改。
- AC3 公共 Bot 使用者的个人会话不出现在团队列表/团队搜索（消费 MT018 public-bot-usage 先例：公共 Bot 会话=使用者本人私有）。
- AC4 撤权后（MT007 停用语义）消息读写与 replay 立即失效（事务内重验，无 epoch bump 依赖）。

## 交付约束
- 新文件建议：src/enterprise/tenancy/conversation-actions.ts（或贴近 conversations-list.ts 同缝）+tests/multitenancy/conversation-actions.test.ts+support/。
- 跨公司/不存在 ID=canonical RESOURCE_NOT_FOUND 逐字节同形（MT009 语义）；deny 零写入零副作用。
- 禁改既有 verified 交付文件（conversations-list.ts a7d5820b 冻结面，只消费不改）；如必须改，停下escalate。

## 验证（全项亲测）
- 专用容器端口 55563：pgvector pg16、KB 角色（ent_w14a_kb）先建、三库（主 openbot_enterprise_w14a_test、assigned=主库名_assigned、KB openbot_kb_w14a_test OWNER=KB 角色）、七变量 env 0600 用后删。
- 三步配方（缺一不可）：①enterprise-test-db.ts migrate（自动建 ent_w14a_{directory,data,operator} 入组）②逐任务 migrate-test.ts generate+migrate --apply 十六链（MT004→…→MT070）③bun test。
- 基线复现：全量 990/0/0/38；交付后聚焦新套件全绿+全量=990+新增用例数/0/0/38+（新文件数）。
- 变异注入自证：每个新判定分支≥1 变异（注入→聚焦 fail→恢复哈希闭环→复绿）。
- typecheck 0；biome 触及文件 clean（存量仅 BASE 既有 src/index.ts 4+1 与 app.ts/provider-oauth.test.ts——MT030 复审 F1 口径，任何新增违规=FAIL）。
- checkpoints/MT022/（before/after-hashes、red-green、mutation、verification）；报告 reports/MT022.md。
- 禁 find / 全盘扫描；禁本地 git commit；测毕 docker rm 回显存档。
