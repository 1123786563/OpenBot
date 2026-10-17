# Hindsight 个人记忆 Ledger（可恢复）

规则：压缩/上下文滚动后从本文件 + git + Orca Run 状态重建，不依赖模型回忆。
执行工作区：/Users/wuyongjun/trea/OpenBot-hindsight-exec（detached @ f0520524）。主工作区 /Users/wuyongjun/trea/OpenBot 保持用户原有改动不动，不用 git stash。

## 授权边界

允许：隔离工作区生产代码、测试、配置、文档；真实自托管实例隔离测试（不指生产数据）。
禁止：新增本地提交、推送、合并、生产数据迁移、部署、开放 Hindsight API/控制台、向用户启用功能。检查点一律未提交（HEAD+diff+哈希+未跟踪文件）。

## 事实源基线（2026-10-15）

- Git 基线：f0520524（= main，与 #6 评论记录一致）
- Spec：docs/specs/2026-10-15-hindsight-personal-memory-design.md sha256 2b5309998bef9032489407096f46e4fda37b167b0fbfa1a0c116869e1157ff3d（主工作区未跟踪→已复制到执行工作区，哈希一致）
- ADR：docs/adr/0005-self-hosted-hindsight-for-personal-memory.md sha256 d092db73eb403115903d309ce0e3243d158199d3f26948324a5d13f5b2923916（同上）
- CONTEXT.md：sha256 92c7d982…（含未提交个人记忆术语 + 用户 billing 工作术语；billing 部分不混入本次交付，仅作为共享词汇表背景）
- Issue 快照：issue-snapshots/issue-{6,82,376,377,378,380..396}.json（gh api，含评论；#6 有 3 条评论，其余 0）
- 代码现状核验：personal_memories 表有 reviewState 列但无公司/租户归属列；store.ts listForAgent（Bot 召回）无 reviewState 过滤——父 Spec"现状证据"属实

## 外部阻塞裁决（T0）

- #82 未实施（详见 dag.json external_blockers）→ #381、#383、#394 及其传递闭包（除 #377/#378/#380 外全部 16 张）不可派发
- #6 全功能隔离未验收 → #396 最终门禁不可满足
- 结论：可执行集 = {#377, #380}，随后 #378

## Orca Run

Run: run_6ec4ffc33d89（objective: Hindsight 个人记忆集成）。coordinator：主会话（Claude）。

| Ticket | Task ID | Dispatch ID | Worktree | Agent/模型 | 状态 | 检查点 |
| --- | --- | --- | --- | --- | --- | --- |
| #377 | task_5ce34b97c059 | ctx_bd6cbe9d529d | /Users/wuyongjun/orca/workspaces/OpenBot/hs01-candidate-review（分支 1123786563/hs01-candidate-review，base f0520524 已核对） | pi；实际生效 glm-5.3 • medium（08:47 终端状态栏观察，非 launch receipt——worker-read fallbackReason: provider_unsupported） | dispatched 08:41:39；08:47 investigating：分析 memory-intelligence.integration.test.ts 的 unreviewed 召回 | 报告约定 reports/ticket-377.md |
| #380 | task_f6621e94833a | ctx_4dcacc484235 | /Users/wuyongjun/orca/workspaces/OpenBot/hs03-selfhost-service（分支 1123786563/hs03-selfhost-service，base f0520524 已核对） | pi；实际生效 glm-5.3 • medium（同上来源） | dispatched 08:41:51；08:47 investigating：盘点 Hindsight 镜像 tags 固定版本 | 报告约定 reports/ticket-380.md |
| #378 | task_7e456259cba9 | （未派发） | — | — | pending，被 task_5ce34b97c059 gate | — |

## 裁决记录

（question/escalation/worker_done 处理记录）

## 已验证 Ticket

（verified+reviewed+integrated 后记录：验收证据、测试输出、diff 范围、review 结论）

## 遗留/待完成

- #82/#6 外部前置未满足 → 16 张票阻塞
- 无部署/启用授权 → #396 外部验证与启用动作待完成

### 裁决 1（2026-10-15 ~08:58，msg_7e3954ab142d，#377 question）

- 问题：proactive-store.integration.test.ts 旧前提"unreviewed 即可召回"与新门槛冲突，文件不在原 ownership。
- 裁决：授权修改。Spec #377 验收明确未审核候选对原 Bot 与 SQL 降级均不可见；修复=测试内模拟本人确认（update reviewState=confirmed）后断言，保留 Bot 归属验证原意。ownership 扩展至该文件该处；推广规则：其他文件同类前提失败同样处理并逐处报告。

### #377 实现完成与 coordinator 验证（2026-10-15 ~09:15）

- worker_done msg_4f643ef7efac（dispatch ctx_bd6cbe9d529d → completed；task → completed）。
- 实现内容：store.ts eligibleRows 追加 reviewState IN ('confirmed','edited')（全部 Bot 侧召回单 seam）；tools.ts 工具描述；4 测试文件扩展 + 1 处授权的 ownership 外修复（proactive-store）。
- coordinator 亲自复验：6 文件 sha256 与报告一致；HEAD f0520524；改动文件=报告所列 6 个，无越权；TEST_DATABASE_URL=…5571… bun test 29 pass/0 fail（亲自运行）；server tsc --noEmit 干净。
- worker 证据：RED 4 失败→GREEN；9 文件 88 pass/0 fail/0 skip；biome 预存在 noConsole（stash 对照）；无关预存在失败 intelligence-contracts 稀疏数组（HEAD 即败）。
- 测试库容器：openbot-hs01-377-pg（127.0.0.1:5571/openbot_hs01_377_test，pgvector pg17，全量迁移）。
- 独立审阅：task_c1c8b6bd9ea7 → dispatch ctx_271bb5df5dbf（pi，同 worktree 只读，两维度结论）。等待中。
- #378 task_7e456259cba9 已被 Orca 标 ready；coordinator 门禁：review 通过+集成后再派发。

### 裁决 2：#377 审阅 findings 处置（2026-10-15 ~09:35，review msg_05a32d980133）

- Reviewer：Spec 3/3 PASS；无 critical/high；4 low + 2 info；独立复跑 88/88、20/20、typecheck 0 错误；sha256 核对一致；无越权文件。
- Finding 2（tools.ts 措辞）→ 修复：task_647c342db814，复用原 terminal term_cf3550e0（dispatch 新回执）。
- Finding 1（谓词双表示）→ 不返工（reviewer 建议）；记录为 #384/#392 波次输入：允许的 reviewState 集合提为单一常量。
- Finding 3（已确认导入上游变化不经再审，预存在）→ 记录为 #378 派发 brief 输入：决策"digest 变化且 confirmed 是否降回 unreviewed"。
- Finding 4（跨入口 e2e）→ 已分配 #385/#396（acceptance-mapping 已记录）；#385/#396 展开计划时须包含频道与定时入口真实断言。
- Finding 5/6（info）→ 无行动。
- 修复后流程：reviewer 复用 terminal 独立复审 fix1 → coordinator 集成到执行工作区（显式转移+哈希核对）→ 解锁 #378。

### #377 集成完成（2026-10-15 ~09:50）— VERIFIED

- fix1 复审通过（msg_1144e92566fb：diff-of-diffs 唯一变化=一行描述；其余 5 文件逐字节一致；9 pass 独立复跑）。
- 集成：hs01 git diff（371 行 patch）git apply 到执行工作区；6 文件 sha256 逐一核对一致（store.ts b8fa6e67、tools.ts ed281d71、4 测试文件同原报告）。
- 执行工作区验证：bun install 后 TEST_DATABASE_URL…5571… 29 pass/0 fail；server tsc --noEmit exit 0。
- #377 状态：verified + reviewed + integrated。hs01 worktree 保留该检查点（工作区态）；下一步 #378 复用同 worktree 与 terminal 叠加。

### 裁决 3（2026-10-15 ~10:05，msg_48325214c2a1，#378 question）

- Q1 过期清理接线：index.ts memorySweep（既有周期清理入口）挂 expireStaleCandidates，授权 ownership 扩展约 6 行；不混入 syncDue。
- Q2 敏感标记：无标记方案（不碰 schema/迁移）——行为门槛即可满足验收；敏感自动学习跳过 + 『请记住』敏感内容降级为 unreviewed 候选（复用 #377 审核流）均需测试锁定；#388 需要时再加列。

### 429 配额事件与检查点固化（2026-10-15 ~10:35）

- 两个 Pi worker（#378 ctx_b59532b480fd、#380 ctx_4dcacc484235）模型调用 429：`{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-10-15 18:47:20 重置。"}`（glm-5.3 via Pi；Retry failed after 3 attempts）。终端 live，agent 停滞。
- 不暗中换 agent（用户指令）；已向用户报告精确错误并请示。
- 检查点固化（工作未丢）：
  - #378（hs01）：TDD RED 阶段——server/tests/memory-expiry.test.ts（162 行，sha256 05512c3e…）+ memory-sensitivity.test.ts（275 行，ded6f3be…）已写；生产代码未动（store.ts 等 6 文件 diff = #377 集成态，235+/6-）。
  - #380（hs03）：11 个未跟踪文件已固化（deploy/hindsight/ 8 文件 + server/src/hindsight/{config,health}.ts + 2 测试文件，逐文件 sha256 见本节下表）。
    | 文件 | sha256 |
    |---|---|
    | deploy/hindsight/docker-compose.yml | 20e53cbf…9a04dc813 |
    | deploy/hindsight/hindsight.env | 8877e99f…c38b2457 |
    | deploy/hindsight/hindsight.env.example | e3c429f2…95434409b |
    | deploy/hindsight/README.md | bbe84881…3c046 |
    | deploy/hindsight/backup.sh | 4f91e816…30c1e0b34 |
    | deploy/hindsight/.gitignore | ad5f630d…d2f5c572 |
    | deploy/hindsight/test/gateway-standin.mjs | 3063876c…259368202434 |
    | server/src/hindsight/config.ts | d10aa347…8b33bc3bfab |
    | server/src/hindsight/health.ts | 76c4afc3…cd039a74d97 |
    | server/tests/hindsight-config.test.ts | 52700e33…09f2356d37 |
    | server/tests/hindsight-health.test.ts | 837a5bf3…8936c0696 |

### 用户裁决：429 处置选 A（2026-10-15 ~10:45）

- 等待 18:47 配额重置；届时向 ctx_b59532b480fd（#378）与 ctx_4dcacc484235（#380）发 follow-up 恢复指令（Pi CLI 当前回合已失败，需 nudge）。不换 agent。

### 等待期预验证（2026-10-15 ~10:55，coordinator 只读）

- #378 RED 真实性：sensitivity.test.ts 因 `../src/memory/sensitivity` 模块不存在失败（标准 TDD RED ✓）；**expiry.test.ts:5 有 import bug**：`users` 从 `../src/db/schema/memory` 导入，实际在 `../src/db/schema/core`——恢复后实现者先修此一行再继续。
- #380 已写单测独立运行：hindsight-config + hindsight-health **19 pass / 0 fail**（无 Pi 参与，coordinator 直接运行）。#380 剩余工作主要是真实实例验证证据与报告。
- 恢复机制：durable cron 4b675312 于 18:52 触发 nudge 两个 dispatch。

### 会话接管与 429 恢复续行（2026-10-15 22:50 CST，新 coordinator 会话）

- 原 coordinator 会话已不可用；新会话 run-use 接管 run_6ec4ffc33d89（receipt requestId 6d6bc9f9）。
- 环境复核：主仓库 main 已推进到 bab7c0b9（提交了 spec/ADR/CONTEXT 记忆术语），相对 f0520524 仅新增 docs 文件，与执行工作区无冲突；两文档 sha256 与 Ledger 基线一致。先前会话所记"未跟踪"已被该提交解决。
- worker 状态核验（terminal read 实证）：#378 term_cf3550e0 停于 429 code 1308（5h 上限，18:47:20 重置）；#380 term_015d9c58 于 18:56 恢复过一轮（重建 hindsight.env 隔离替换、force-recreate 容器、standin LLM probe），18:57 遭 429 code 1302 速率限制后回合终止。两终端均 live、agent idle 于提示符。
- 恢复动作：send msg_7430c19230b8（#378 恢复指令，含 expiry.test.ts:5 import 修复提示）与 msg_94da656a7ac6（#380 恢复指令：真实实例隐私断言+证据+报告）；terminal send 双双 nudge。22:55 进入 check --wait。
- 测试库 openbot-hs01-377-pg（5571）与 openbot-hindsight 容器（8888）均在运行。

### Orca 运行时重启恢复（2026-10-16 00:05 CST，第二个新 coordinator 会话）

- 会话与 Orca 运行时先后重启（runtimeId 0f796426→58ad49b0）；旧终端句柄全部 terminal_handle_stale。
- worker-list 判定：#378 ctx_b59532b480fd 与 #380 ctx_4dcacc484235 均 abandoned/failed（detail terminal_missing）；#377 系 4 dispatch 均已结算。已 release：ctx_b59532b480fd、ctx_19f08501a4e4（reclaimable）、ctx_4dcacc484235。
- 替代 worker（同 worktree 叠加，agent=pi）：#378 → dispatch ctx_0816613e2458（terminal term_f8dc38c3）；#380 → dispatch ctx_82a231c8e38b（terminal term_149e3cc6）。重试用 worker-start --task（task 状态回 ready，retry-of 被拒为正确行为）。
- 自足恢复指令：msg_f489de9c76ff（#378，含 expiry.test.ts:5 import 修复与既有 RED 文件清单）、msg_d41fc6bf958e（#380，含 19-pass 单测结论、容器状态与剩余真实验证步骤）。
- 进入 check --wait 监听 worker_done/escalation/question。

### #378/#380 实现完成与 coordinator 复验（2026-10-16 00:20 CST）

- #378 worker_done msg_002028b7a4cb（ctx_0816613e2458，succeeded）：sensitivity.ts 保守分类器；create/formMemory/update/completeSync/sync 五路径凭据拒收+敏感降级候选；expireStaleCandidates 30 天幂等 tombstone 接入 memorySweep（授权扩展）。coordinator 亲验：7 文件 sha256 与报告一致；5573 库全套回归亲跑 102 pass/0 fail；tsc exit 0。报告 reports/ticket-378.md。
- #380 worker_done msg_b02f44fb9b63（ctx_82a231c8e38b，succeeded）：真实实例 Hindsight 1.0.0(digest a88678c0) 端到端验证——liveness/version/401 auth 拒绝、网关路由 standin 日志证明、隐私运行值(env+features+llm_requests=0 三重证据)、健康四态+恢复、备份 29/31 天边界+真实 dump 57.9KB；修复 2 真实 bug（health.ts API 形状、backup.sh pg_dump PATH）。coordinator 亲验：11 交付文件 sha256 一致；单测亲跑 21 pass/0 fail；tsc exit 0。报告 reports/ticket-380.md。
- 审阅派发：task_d7e8a42481fa（#378，reviewer 在 hs01 只读）、task_ea8b964737e3（#380，reviewer 在 hs03 只读），agent=pi。

### 裁决 4:#378 审阅 findings 处置（2026-10-16 01:5x CST）

- Reviewer（task_d7e8a42481fa，ctx_0a34097dc7e1）：Spec PASS / 质量 PASS；0 critical / 0 high / 1 medium / 3 low / 5 info；独立复跑 9/9、102/102、tsc 0、biome 0；sha256 逐字节一致。
- F-M1（update() 编辑敏感内容直接 edited 可召回，create() 需二次确认）→ coordinator 裁决采 reviewer 方案 b：编辑成 medical/financial/customer-data 也落 unreviewed（ADR 0005"即使由本人明确要求……也须再审核一次"，编辑即明确要求；收紧方向安全）。修复 task_223af17a6a23。
- F-L1（凭据形状缺口 pwd/ssh key/connection string）、F-L2（bearer 误伤协议描述）、F-L3（sync 丢弃静默）→ 同批修复。
- F-I1..I5 → 无行动（F-I4 检查点完整性核验通过）。

### 裁决 5:#380 审阅 findings 处置（2026-10-16 01:5x CST）

- Reviewer（task_ea8b964737e3，ctx_372ebbb9b985）：Spec PASS / 质量 PASS；3 low / 4 info；独立复跑 21/21、tsc 0、隐私三重证据（env+features+llm_requests=0）复现、401/边界/密钥隔离全部复核。
- F1（-mtime +30 实际 ~31/32 天尾巴）→ 修：改 +29 严格 ≤30 天。修复 task_93e8db38f181。
- F3（example 网关 URL 容器内不可达提示）→ 修：example/README 加 host.docker.internal 说明。
- F2（health 不交叉核对 runtime features）→ 不修本票：AC 字面满足且人工三重证据闭环；记为 Wave 2(#385/#391 展开)输入。
- F4..F7 → 无行动；F4 范围偏差（client.ts 骨架未交付）记录在案：dag interfaces 未要求，无害。
- 修复 worker 复用原实现者终端（--terminal + 显式 --worktree;--agent 与 --terminal 互斥属预期）。

### 裁决 6:fix1 复审通过与集成（2026-10-16 04:0x CST）

- #378-fix1 复审（task_04ba5e3a273d）：变化恰为 4 项（sensitivity/store/ingestion/sensitivity.test），103/0 全绿，双维度 PASS。
- #380-fix1 复审（task_4e7af9986454）：变化面恰 F1+F3，其余 9 文件逐字节一致，双维度 PASS。
- 集成：hs01 11 文件复制到执行工作区（11/11 哈希一致）；hs03 11 交付文件+报告（12/12 一致）。集成后总验证：103 pass（memory 12 文件）+ 21 pass（hindsight）+ tsc 0。
- #377/#378/#380 状态：verified + reviewed + integrated（含 fix1）。

### 裁决 7:OCR 轮 1 处置（2026-10-16 04:5x CST）

- OCR workspace 模式（session c782f4b2，provider z-ai-coding / model glm-5.3-flashx，effort 默认 medium，12 文件 +4141/-13，21 comments：8 medium/13 low，0 critical/high，budget 无告警）。
- 必修 medium：R1 backup.sh PGPASSWORD 经 docker exec -e 进 argv（→stdin 传递）；R2 RETENTION_DAYS=0 生成 -mtime -1 崩溃；R4 compose 缺 extra_hosts host-gateway（Linux 部署 gateway 恒 down）；R7 store.ts update() intelligence 分支敏感编辑绕过门槛（supersede 直写+intelligenceOnly 返回 Bot）；R8 backup.sh 只读宿主 env，cron 下恒 30（→从 hindsight.env 回退）。
- 与 F2 同源（config.ts 声明 vs 运行值交叉核对）→ 维持 Wave 2 裁决（#385/#391 输入）。
- health.ts:158 catch 一律 gateway_down：修为日志增强（不改四态语义与状态键集）。
- 顺手 low：backup.sh umask077+trap+gzip -t；sensitivity "passcode is" 散文误判收窄（要求值形态）；health.ts PrivacyViolationId[] 收紧；health deps ?? 默认；backup.sh cron 示例先建目录。
- Wave 2 记录：卡号/SSN 形态、droppedSensitive 透传本人、sweepStep helper、standin/verify-health 工具项、expiry mirror 自愈依赖同 sweep（注释）。
- 误报：docker-compose.yml:16（env.example 在交付集内，被 OCR unsupported_ext 排除审查所致）。

### 裁决 8:最终交付审阅 + carried items（2026-10-16 06:3x CST）

- 最终审阅（task_cddd3145312c，ctx_13a22686d0a0）：PASS，0 critical/high/medium，4 low/6 info；7 项重点全过；103/0+21/0+tsc 0 亲跑；容器实测（401/llm_trace=false/载荷 1 天/单出口/happy=service_up）；明确列出 #82/#6 阻塞范围防越权。报告 reports/final-delivery-review.md。
- F-L2（confirmed 导入上游变化不经再审，未决 carried）：coordinator 裁决归 #384（幂等同步票）Wave 2 展开时显式决策——预存在 HEAD 行为、本 Wave 三票验收不含、修复需与 #384 的 sync 语义共同设计。
- F-L1 双表示常量、F-L3 声明交叉核对：维持既有 Wave 2 裁决。
- F-L4：CONTEXT.md 未提交 diff 含用户自己的 4 个 billing 术语——提交阶段须与本 Wave 交付分离说明。
- OCR fix（hs01 批）已落地执行工作区：104+22 pass，tsc 0，biome 干净；R7 拒绝文案专用化记录在案。

### 裁决 9:OCR fix 完成与复审（2026-10-16 08:0x CST）

- hs01 批（task_0279e54ebac6）：R7（intelligence 分支敏感编辑拒绝，专用文案）+ health.ts 三项（catch 日志增强/violations 收紧/deps ??）+ sensitivity is 分支收窄；104+22 pass，tsc 0。落点执行工作区（hindsight 文件所在地）。
- hs03 批（task_d53a03d1fde5）：R1 stdin 口令（/proc argv 双侧实测无泄漏）、R2 RETENTION_DAYS=0 显式拒绝、R8 env→hindsight.env 回退、R3 umask077+trap+gzip -t、R12 cron mkdir、R4 extra_hosts host-gateway；真实备份 4 次 exit 0、21/0、bash -n/shellcheck 0。集成 3 文件哈希一致。
- 独立复审（task_f0f269c9dc79）：PASS——23 文件 sha256 链一致、变化集恰为授权 9 文件、五项 medium 全部解决（含 645 份 ps 快照 0 命中、645→实时探针、104/0、22/0、tsc 0）；2 条 info 备注记录在 ocr-fix-review.md。
- 执行工作区最终态：104 pass（12 文件）+ 22 pass（2 文件）+ tsc 0 + bash -n OK。
- OCR 轮 2 启动（最终态完整范围重审）。

### 裁决 10:OCR 轮 2 与再修复（2026-10-16 09:5x CST）

- OCR 轮 2（session 773cf8b7 首跑全失败于 LLM API；重跑成功）：z-ai-coding/glm-5.3-flashx，12 文件，15 comments（5 medium/10 low，0 critical/high）。
- 必修 medium：M1 health.ts 租户段 default 常量化（轮 1 low 升级）；M2 config.ts:169 注释如实化（无运行时调用方属 #393 接线范围，不声称 startup fail-loud）；M3 RETENTION=0 双侧统一（config 下界 ≥1）；M4 backup.sh 行解析校验防口令泄漏进日志；M5 八进制 10# 修正。
- 顺手 low：health bank_id 死字段/标题 four-state/service_down 日志；backup flock。
- 不修记录：personal_memories 无 (review_state,deleted_at,updated_at) 索引致 sweep 每分钟顺序扫描——加索引需迁移，db/schema 所有权在 #82 边界，Wave 2（#384）处理；standin/verify-health 工具项 4 条；verify-health prototype 继承。
- 修复 task_6039ed0f9475（hs01）+ task_b945393e8c79（hs03），修复后流程：独立复审 → OCR 轮 3。

### 裁决 11:轮 2 复审通过 + OCR 轮 3（2026-10-16 1x:xx CST）

- 轮 2 修复独立复审（task_8cbc6914b833，重启后第三次执行）：PASS——M1-M5 全解决、23 文件哈希链一致、真 diff 零夹带、104/0+23/0+tsc+bash-n+shellcheck 亲跑、真实 dump 探针；1 low（flock 空读边界）+2 info。期间上游 hiroute 多次 502/400 中断，靠 nudge 循环恢复完成；旧卡死 reviewer task_c12017190b3a abandoned 后 release。
- OCR 轮 3（重跑成功）：glm-5.3-flashx，12 文件 4 comments（2 medium/2 low）。
- 裁决修复：声明-运行值交叉核对（health.ts:103）第三轮复现且 readVersion 数据现成——本轮修（llm_trace 交叉；retention/backup API 不可读仍靠对账，注释如实）；index.ts sweepStep helper 统一三段+日志 name+message（medium1+low2 一并）；gateway_down 语义注释（low1）。
- 修复 task_847fd115970f 执行中。

### 裁决 12:轮 3 修复复审通过 + OCR 轮 4（2026-10-16 21-22:xx CST）

- 轮 3 修复（task_847fd115970f）coordinator 全量复验：104 pass（规范 12 文件）+ 26 pass（hindsight 2 文件）+ tsc 0。
- 轮 3 修复独立复审（task_28872b2a2a1d，ctx_18c48908d5b9，报告 reports/ocr3-fix-review.md）：**PASS**。23 文件 sha256 链一致；变化集以 HEAD 真值 git diff（index.ts 单 hunk）+ 轮前副本累计 diff 分解（health/config 余量恰为轮 3 声明）+ 测试纯新增 3 用例证明零夹带；medium-1（sweepStep 三段统一+日志契约对齐 health.ts detail 形态）、medium-2（llm_trace 声明×运行值交叉核对）确认解决，并亲自对真实容器做正反例运行态复测（真实容器原样 service_up；一次性实例 llm_trace:true → config_noncompliant + [runtime_llm_trace_enabled]；探针产物全清）。findings：F-C1 low（附录"全套"清单把 bot-lifecycle.integration 换成 proactive.test，101/385 实为清单偏差，非代码回归）+ F-C2 info（backup.sh wave-2 rework 未在 ticket-380.md 补附录，文档链缺口延续）。
- OCR 轮 4（btivb4f9c，10m47s，12 文件 996k tokens）：13 comments = **2 medium / 11 low**，0 critical/high。时间线核验：r4 起点 ~21:12 晚于轮 3 修复落盘 16:50，扫描对象确为修复后状态；两 medium 为新发现非旧账复发。
- medium-A（backup.sh sweep 位置）：retention sweep 位于 dump/gzip/gzip -t/mv 全链后，set -euo pipefail 下任一步失败即在 find 前中止，旧副本静默停止删除、突破 ≤30 天窗口。coordinator 读码核实有效。
- medium-B（verify-health.ts:37）：loadHindsightConfig/checkHindsightHealth 无异常处理，坏 env 直接未捕获堆栈。核实有效。
- 11 low 记 Wave 2（config 空串超时 fail-loud、health log.info→warn、find 递归/-maxdepth、超长数字 RETENTION 绕过、standin 三项工具项、verify-health prototype 继承、backup.sh 注释漂移、kill -0 EPERM/ESRCH）。
- 处置：修复 task_448975ce2ad6（worker ctx_0b7dd0ddf72d，hs03 worktree）：medium-A（sweep 移到锁后、manifest 读取前，边界语义不变）、medium-B（try/catch + 简明错误行 exit 1）、F-C2（ticket-380.md 补 wave-2 附录 + ocr4-fix 附录）、F-C1 口径（证据引用逐字用规范 12 文件清单）；验证含 docker stub 失败演练 + 四场景 + 规范套件。完成后独立复审 → OCR 轮 5。

### 裁决 13:轮 4 修复+复审通过 + OCR 轮 5（2026-10-16 22:2x–23:xx CST）

- 轮 4 修复（task_448975ce2ad6，ctx_0b7dd0ddf72d）：medium-A sweep 前置（锁后、manifest 前，边界注释逐字保留+取舍注释）、medium-B try/catch 单行诊断、F-C2 wave-2 补记 + ocr4-fix 附录、F-C1 规范清单口径。coordinator 亲验全绿：sha256 恰两文件变动（backup.sh→19beb92f、verify-health.ts→590ffddf）、bash -n、/tmp 失败演练独立复现（stub dump 失败仍删 31 天留 29 天）、坏 env 单行 exit 1、规范 12 文件 104/0/408、hindsight 26/0/61、tsc 0。
- 轮 4 复审（task_80c27c0424f0，ctx_4568550b48c7，reports/ocr4-fix-review.md）：**PASS**。23 文件哈希链零偏差；变化集恰 3 文件零夹带；medium-A 附强对照（旧版脚本同演练 31 天幸存→缺陷真实）；F-C1/F-C2 闭合，backup.sh 检查点链 538d0fc4→b7270f9d→19beb92f 三环全登记。2 info：F-D1（执行者 /tmp 探针残留——coordinator 已清）、F-D2（头部索引行，裁量）。复审者 /tmp 残留已清、standin 9100 归零。
- OCR 轮 5（7m49s，12 文件）：7 comments = **1 medium / 6 low**，0 critical/high。
- medium-C（gateway-standin.mjs:34 + hindsight.env.example:22/30）：轮 4 standin low 升级。事实：example 两处默认值恰为 http://host.docker.internal:9100/v1（替身默认端口 + 容器可达形态），替身无鉴权、无硬性护栏，"生产禁用"仅头注释——照抄 example 即把未鉴权替身当已批准网关。核实属实。
- 裁决修法：example 网关 URL 默认值改 change-me 占位符（与文件内 key 占位符惯例一致，照抄即 fail-loud），host.docker.internal 指引降为注释（仅隔离验证）；standin 加硬护栏（非回环 --host 需显式 --allow-non-loopback，拒绝文案说明载荷含个人记忆内容）；顺手同文件 low（--port/--host 缺参 NaN 校验、req error 处理器）与 backup.sh:55 注释失实修正（config MIN=1）。README 同步。其余 low（verify-health exitCode、startsWith 死代码、.part SIGKILL 累积、appendFileSync）记 Wave 2。
- 修复后流程：独立复审 → OCR 轮 6。

### 裁决 14:轮 5 复审通过 + OCR 轮 6（2026-10-16 23:xx–24:xx CST）

- 轮 5 修复（task_c11c6036bc85）：example 占位符 + standin 硬护栏 + 端口校验 + req error 处理器 + backup.sh 注释如实化。coordinator 亲验：行为矩阵 9 场景（护栏拒绝 exit 2 无监听/旗标可绑定往返/缺参与 abc 可读报错/默认回环可用）、example 无未注释 9100 残留、bash -n、104/0/408 + 26/0/61 + tsc 0、附录哈希与重算一致。
- 轮 5 复审（task_fbd370058dc7，reports/ocr5-fix-review.md）：**PASS**。23 文件零偏差、零夹带（backup.sh 以 wave-2 副本累计 diff 分解）；护栏矩阵 9 场景独立复测（含 --port 70000/0/--port --host 边界）；断连进程存活实测；F-C1 闭合。findings：F-E1 low（附录"照抄即被 config.ts 拒绝"机制表述不精确——config.ts 不消费那两个键，占位符的 fail-loud 路径是 HINDSIGHT_MODEL_GATEWAY_URL/HINDSIGHT_API_URL 与 Hindsight 自身客户端）、F-E2/E3 info（ledger 不在附录变化集声明、头部索引）。遗留卫生备注：/tmp 存更早轮次旧探针残档，供统一清扫。
- OCR 轮 6（5m11s，12 文件）：10 comments = **3 medium / 7 low**，0 critical/high。medium 轨迹 8→5→2→2→1→3：一条为 r4 low 升级（log.info→warn），两条为我们自己前轮修复引入/暴露（r5"BOTH sides"注释承诺过头；ocr3 gateway catch 注释 token 配错→gateway_down 与真实行为不符——token 错在 /health 401 即落 service_down）。
- medium-D（health.ts 两处探针 catch log.info→log.warn）：仓库先例（index.ts:3520、routines/sweep.ts、culler.ts:217）均 warn；真实故障需运维感知。有效，修。
- medium-E（backup.sh 缺失/空声明静默默认 30 vs config.ts null→violation 分叉）：example 声明该键（=30）故照抄部署不触发；但键被删/留空时脚本静默 30、健康检查持续 noncompliant，与头注 keep-them-in-sync 及 r5 新注释 BOTH-sides 承诺相悖。有效，修法采 OCR 建议(a)：两层解析后仍空 → 响亮失败（与 ADR"显式声明缺失即不合规"对齐）；演练与 cron 需显式声明。
- medium-F（service 探测 4xx/5xx 与不可达混同 service_down + gateway catch 注释失实 + 无非 2xx 测试）：OCR 建议①已被现状满足（requestJson 抛 "request failed with status N" 进 detail，日志可区分）；修②③：service catch 注释写明粗粒度映射（含鉴权被拒）、修正 gateway catch 注释 token 结论、补 /health 401 → service_down 回归测试钉住语义。
- 7 low 记 Wave 2（tenant 段常量 vs bank config 双表示=既有裁决归 #384/#392；sweepStep 丢栈；sensitivity 不可达 try/catch；backup.sh 无自动化测试；standin appendFileSync/路由清单双维护=复现第三轮；verify-health 冗余 env 拷贝）。
- 修复后流程：独立复审 → OCR 轮 7。若轮 7 再现新 medium 且均为已裁决 Wave 2 性质的文档/惯例项，将向用户呈交收敛数据与处置建议而非无限循环。

### 裁决 15:轮 6 复审通过 + OCR 轮 7（2026-10-17 0x:xx CST）

- 轮 6 修复（task_2eab9fbc6546）：log.warn×2、retention 显式声明护栏（两层后空→单行拒绝 exit 1）、401 语义注释修正+回归用例。coordinator 亲验：无声明演练 exit 1 单行报错、有声明+docker stub 演练仍删 31 留 29、gateway catch 注释与控制流一致、104/0/408 + 27/0/62 + tsc 0。
- 轮 6 复审（task_a4120a4c3658，reports/ocr6-fix-review.md）：**PASS**（sha256 全表零偏差、三 medium 解决、Wave 2 七条 low 逐条对码核实；1 info 为 OCR 工具行号漂移备注）。
- OCR 轮 7：11 comments = **4 medium / 7 low**，0 critical/high。medium 轨迹 8→5→2→2→1→3→4，未收敛——构成：两条 Wave-2 low 升级（backup.sh 递归无 -maxdepth=r4 low；.part SIGKILL 残留=r6 low）、一条新观察（verify-health bad-config 场景不自足，依赖带外改 env）、一条实质安全项（sensitivity 凭据形状缺口：下划线风格密钥 sk_live_/client secret 等漏成 normal→confirmed→镜像，与 tools.ts "always refused" 承诺相悖）。
- 裁决：四条全修（安全项必须修；两条升级项各为一词/一块的小修；场景自足化使四态矩阵可自动复现）。另并入同文件三连复现 low：verify-health process.exit→exitCode（管道截断，r5/r6/r7 三轮）、头注 Three-state→Four-state、usage 串统一。其余 low（standin 路由双维护三连、listen error、tools.ts 承诺措辞、sensitivity 死代码注释等）仍记 Wave 2。
- 若轮 8 后仍再现新 medium：向用户呈交收敛轨迹数据（8→5→2→2→1→3→4→N）与处置选项，不再无限循环。

### 裁决 16:轮 7 复审通过 + OCR 轮 8（2026-10-17 01:xx CST）

- 轮 7 修复（task_1c35abc15ee0 + 微补充 task_2ab4043a8252，后者系 coordinator 复验发现新注释例子 password:see-the-vault-stays-normal 与顶部名称即拒 pattern 矛盾后追加）：-maxdepth 1 双清扫、.part 无条件清理、bad-config 自注入、凭据下划线/前缀形状族、exitCode 自然退出、Four-state 头注、usage 统一。coordinator 亲验：四合一演练（31 删/29 留/子目录不动/.part 清）、bad-config 死网关 URL 下 config_noncompliant exit 0、凭据形状 7 例抽查（含散文反例）、104/0/420 + 27/0/62 + tsc 0、微修后全量复跑同绿（独立跑 memory-sensitivity 缺 TEST_DATABASE_URL 会环境性失败，带库 7/0/84）。
- 轮 7 复审（task_9fa69c6fa56f，reports/ocr7-fix-review.md）：**PASS**（19+4 文件哈希链零偏差、四 medium 与微补充全解决、Wave 2 清单逐条对码、无 critical/high/medium；1 info 行号转写漂移）。
- OCR 轮 8：11 comments = **3 medium / 8 low**。medium 轨迹 8→5→2→2→1→3→4→3。
- medium-G（sensitivity 缺 recovery/seed/mnemonic phrase、2FA/MFA 备份码、OTP/验证码形状）：钱包助记词类高价值秘密可漏成 normal→confirmed→镜像。实质安全项，修。
- medium-H（backup.sh:145 kill -0 EPERM 误判）：r4 low 升级。无 flock 回退路径把他用户存活持锁进程判 stale 偷锁。修：kill -0 失败后用 ps -p 复核，ps 可见即按存活拒绝。
- medium-I（backup.sh:67 拒绝文案等价性过头）：文案称 env 或 hindsight.env 二选一皆可，但服务端 loadHindsightConfig 只读 OpenBot 进程 env——仅 hindsight.env 声明时脚本放行而健康检查仍 noncompliant。修：文案如实（脚本侧两层皆可；服务端合规须在 OpenBot 部署 env 声明，对账归 #391）。
- 8 low 记 Wave 2（readVersion 静默 {}、空 operations→gateway_down、SIGINT/SIGHUP trap、standin 路由双维护四连/listen error/查询串 404//tmp 符号链接日志、ingestion 双份判定、store 嵌套三元）。
- **收敛承诺**：本轮为最后一轮静默修复循环。轮 9 后无论结果，向用户呈交完整轨迹（8→5→2→2→1→3→4→3→N）、已修清单、Wave 2 遗留清单与处置选项（继续逐轮 / 以当前状态验收）。

### 裁决 17:OCR 轮 9 与最终收敛安排（2026-10-17 02:xx CST）

- OCR 轮 9（8 comments = 3 medium / 5 low）。medium 轨迹：8→5→2→2→1→3→4→3→3。
- medium-J（standin 回环守卫字符串匹配不解析主机名）：**裁决为误报不修**。OCR 场景"传入解析到非回环的主机名无需 --allow-non-loopback 即可绑定"与实现相反——该类主机名不在 LOOPBACK_HOSTS 集合即被拒绝、必须显式旗标；唯一残余是 /etc/hosts 把 localhost 重映射到非回环的本机级篡改（此时攻击者已控制操作者机器，防护对象不存在）。listen 后 address 校验可作为 Wave 2 加固项记录。
- medium-K（backup.sh 无 flock 路径 PID 复用→死锁永久判活→备份链静默停摆）：有效。修：锁文件记录 PID + 进程启动时间（ps -o lstart=），判活时 lstart 不匹配即 PID 已复用、按 stale 处理。
- medium-L（store.completeSync 内层敏感 continue 静默，与 ingestion"计数是唯一信号"声明矛盾）：有效。修：内层 continue 补计数与日志（形状对齐 memory-sync-sensitive-dropped，独立 type 标注防线层级）。
- 5 low 记 Wave 2（readVersion 空 catch 无日志、expireStaleCandidates 无索引全扫=既有裁决、超长数字溢出正则、路由双维护五连、导入隐式 unreviewed 组合）。
- **最终安排**：本批（J 不修 + K/L 修）为收敛前最后修复批；复審 PASS 后跑 OCR 轮 10：若 0 critical/high/medium → 宣布完整范围通过并做最终交付总结；否则向用户呈交完整轨迹与处置选项并停止循环等待裁决。

### 裁决 18:OCR 轮 10 与循环终止（2026-10-17 03:xx CST）

- OCR 轮 10：12 comments = **2 medium / 10 low**，0 critical/high。medium 轨迹全记录：8→5→2→2→1→3→4→3→3→2。
- 轮 10 两 medium 均初判有效但未修（循环终止）：M-α（backup.sh flock 分支与 noclobber 创建式锁互不感知——exec 9> 截断创建式锁指纹、混用同目录互斥失效，真实但仅限多主机共享备份目录场景）；M-β（docker-compose.yml:10 注释与 r8 修正后的三层真相矛盾——r8 文案修正的下游遗漏）。连同 10 low 一并入交接清单。
- **循环终止依据**（裁决 15/16/17 承诺兑现）：OCR 为非确定性 LLM 评审，每轮对约 15-20 条存量观察重新掷骰，low 随机升级 medium（已发生 5 次：maxdepth、.part、kill-0 EPERM、凭据缺口、sweepStep），"0 medium 收敛"不保证可达；实质缺陷（凭据/助记词拒收、隐私窗口硬上限、护栏、日志可观测性）已在轮 1-9 全部修复并经独立复审 PASS；剩余项均为小众加固/一致性/工具项。继续循环的边际收益低于其时间成本。
- 终态：#377/#378/#380 含轮 1-9 全部修复，检查点 = HEAD f0520524 + 未提交 21 项；规范 12 文件 105/0/439 + hindsight 27/0/62 + tsc 0 + bash -n 0。轮 10 的 2 medium + 10 low 为有界交接清单（reports/ocr-result-r10 记录 + 本 ledger），处置由用户裁决。

### 裁决 19:轮 10 修复复审通过 + OCR 轮 11 + 循环冻结（2026-10-17 13:xx CST）

- 轮 10 修复（task_c27349378543）：flock 分支改追加打开+取锁前内容预检（与创建式同判活规则、PID 复用 fall-through、活指纹 mixed-styles 拒绝、持锁后重写两字段指纹、跨主机边界注释）+ compose 头注三层如实化。coordinator 亲验：flock-shim 活指纹拒绝/死指纹放行且重写/两 medium 全闭环、compose config -q 通过（临时 example 占位后删）、旧 agree 句式消失、105/0/439 + 27/0/62 + tsc 0。
- 轮 10 复审（task_057bb704449e，reports/ocr10-fix-review.md）：**PASS，零 findings**（仅 1 条 Wave 2 行号观察 + 1 条审阅侧 harness 备注）——十轮复审中最干净。
- OCR 轮 11：10 comments = **4 medium / 6 low**。其中 2 条 medium 指向轮 10 修复本身（flock 指纹消息口径——行为等价的拒绝、仅文案不准；bash -x xtrace 下口令展开盲区——新观察）。**循环正式冻结**：最干净复审后仍 +2 medium 且两条自指，非收敛性（修复引入新评审面）被最终实证。
- **最终交接清单**（Wave 2 输入，不再修复）：r11 的 4 medium（flock 消息口径、xtrace 口令盲区、sensitivity diagnos 误伤高频技术词、health.ts llm_trace 交叉核对被 gateway_down 掩盖的顺序问题）+ r11 的 6 low + 累积 Wave 2 项（r1-r10 各裁决所记）。完整索引：本 ledger 裁决 7-19 + reports/ocr-result（/tmp/ocr-result-r1..r11.json）。
- **冻结终态**：11 轮 OCR（medium 8→5→2→2→1→3→4→3→3→2→4）、10 批修复全部独立复审 PASS、0 critical/high 存量；测试 105/0/439 + 27/0/62 + tsc 0 + bash -n/compose 校验通过。
- 用户已授权提交序列（2026-10-17"按照你的建议顺序开始"）：冻结后按票拆分提交、push、开 PR（CONTEXT.md billing 术语分离，裁决 8/F-L4）。
