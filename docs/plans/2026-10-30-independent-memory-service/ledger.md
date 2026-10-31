# 独立个人记忆服务 · 执行 Ledger（#713 / 子票 #714–#733）

> 工作区：OpenBot（本目录，分支 memory-service-713）、/Users/wuyongjun/trea/openbot-identity（IDENTITY）、/Users/wuyongjun/trea/openbot-memory（MEMORY，实施仓）。
> 授权边界：本地工作区与新仓库内实施/验证；提交/推送远端/建远端仓库/改关 Issue/生产迁移/部署/清理真实数据不在本提示词授权内。本地提交仅作检查点。
> 规则：gh 写入须 `--repo 1123786563/OpenBot`；OCR 仅最终提交前完整跑一次；每票 = 读票 → 测试先行 → 实现 → typecheck/build → 提交 → 独立审核 → 修复复验 → 本文件记录。

## 1. 票状态

| 票 | 主题 | MEMORY 提交 | 本票验证 | 独立审核 |
|---|---|---|---|---|
| #714 | OIDC 登录骨架 + id_token 校验 | 976735f（+ bcc2831 骨架） | tests/issue-714*.test.ts | 已过修复轮（f2be0a6） |
| #716 | 应用登记与逐动作委托 | b6bd57b | tests/issue-716.test.ts | 已过 |
| #717 | 采集管道（原子回执/幂等/租约/重验） | be8d54c | tests/ingestion-reliability.test.ts 等 | 已过修复轮（12c0e61/6028c21） |
| #718 | 候选审核管理站 + 浏览器 e2e | 93647fa / 39618b8 | tests/e2e/candidate-review.e2e.ts | 已过 |
| #719+#720 | 显式记住（敏感闸门）+ 受控召回（围栏/来源核验/503 信封） | d757778 | tests/explicit-remember.test.ts、recall-isolation.test.ts | 已过修复轮（8762652/3795c34） |
| #721 | 学习/使用独立暂停 | 1322e62 | tests/issue-721.test.ts | 已过修复轮（49676b1） |
| #722 | 更正 + 有效区间 + asOf 历史召回 | 4399de5 | tests/issue-722.test.ts | 已过修复轮（91593e6/8c70271/843c093） |
| #723 | 依据派生（继承全部依据限制） | 7177506 | tests/issue-723.test.ts | 已过修复轮（a640e56） |
| #724 | 逐版本只读共享 | 7699d6a | tests/issue-724.test.ts | 已过修复轮（a6670f7/c0988c5/d2aecaf） |
| #725 | 撤销共享与副本清理（通知/回执/清理视图） | e01a34d | tests/issue-725.test.ts（6→10 用例）+ 浏览器段 | 审核 1 轮：7 confirmed（去重 5 类）→ 修复轮 c21fbfb 已提交，五条变异全杀，复验 124/124 绿 |
| #726 | 遗忘与来源撤销 | d216808 + 修复轮 b89b2d3 | tests/issue-726.test.ts（7→12 用例）+ 浏览器遗忘/来源撤销段 | 审核 1 轮：15 confirmed（去重 4 类）→ 修复轮 b89b2d3，五条变异全杀，12/12 绿 |
| #727 | 后台预算与用量 | 861b15b + 修复轮 c12cb30 | tests/issue-727.test.ts（5→9 用例）+ 浏览器 /activity 段 | 审核 1 轮：10 confirmed（去重 6 类）→ 修复轮 c12cb30，五条变异全杀，143/143 绿 |
| #728 | 内容保留与恢复 | acc43be + 修复轮 533bb75 | tests/retention-restore.test.ts（5→10 用例） | 审核 12 confirmed（去重 7 类）→ 修复轮 533bb75，六条变异全杀，148/148 全量绿 |
| #715 | 保留现有用户身份接入统一登录 | IDENTITY 514143c + OpenBot 4e52125b6 | tests/issue-715.test.ts（6 用例，IDENTITY）+ server/tests/identity-center-continuity.test.ts（6 用例，OpenBot） | 七条变异全杀（IDENTITY 5 + OpenBot 3 中重复计 2）；OpenBot 投影用合同夹具（企业测试库未运行） |
| #730 | OpenBot 来源应用接入（来源裁决/服务客户端/上下文装载） | OpenBot c3475e779 | server/tests/memory-service-source-check.test.ts（5）+ memory-service-runtime.test.ts（4） | 四条变异全杀；企业 Access 真实接线未做（5435 未运行） |
| #729 | 服务故障与授权降级 | MEMORY fc7f9a6 + OpenBot e43f3a34a | tests/recall-fallback.test.ts（4，MEMORY）+ server/tests/memory-service-degradation.test.ts（4，原生）+ mastra-memory-service-degradation.test.ts（3，Bun 驱动） | 见 §6c |
| #731 | OpenBot 内嵌记忆管理（承载页/顶层登录回跳/退出） | MEMORY ecdcc6f+feb8455+<static 修复> + OpenBot da8a46b0c+feba5c45a | app/tests/memory-service-frame.test.tsx（5）+ server/tests/memory-service-entry.test.ts（3）+ MEMORY tests/embed-channel.test.ts（3）+ tests/static-embed.test.ts（2）；浏览器五用例 2026-10-31 真实栈手工执行全过（见 §#731 浏览器验收） | 审核 9 confirmed（去重 6 类）→ 修复轮，六条变异全杀；浏览器验收发现 serveStatic 绕过 meta 注入的真 bug，已修复+回归测试（变异验证） |
| #732 | 切换全部消费者并退出旧路径 | OpenBot 工作区 `memory-service-713`（未提交，见 §8） | server/tests/memory-service-no-legacy.test.ts（5）+ 受影响套件复验（见 §8 验证证据） | 实施完成；独立 reviewer 待安排（完整档要求未参与实施的会话） |
| #733 | 端到端验收 | — | — | blocked：依赖 #732 审核与隔离四站环境 |

**当前全量基线（MEMORY）**：单元 17 文件 / 152 用例全绿（含 #728/#729）；浏览器 e2e 1/1 绿；`bun run typecheck`（root+app）绿；`bun run build` 绿。

## 2. #725 审核 finding → 修复记录（c21fbfb）

| finding | 修复 | 变异验证（已还原） |
|---|---|---|
| dispatchPending 成功写回无终态守卫：在途回调期间到达的 completed 回执被降级回 sent，终态丢失且每 60s 无限重投 | `src/cleanup/service.ts` 成功 UPDATE 加 `AND state <> 'completed'` | 去掉守卫 → `dispatch_respects_terminal_receipt` 红 |
| revoke 补建分支（已撤销无清理授权）无并发防护：N 份清理 + N 个不同 notificationId | `share_cleanups` 加 `UNIQUE(authorization_id)`；`trackCleanup` 事务内 `ON CONFLICT DO NOTHING` + 回读 | 去掉 ON CONFLICT → 并发/更正两用例红 |
| revoke 输给 revokeVersion 竞态：204 但无清理事实/通知 | revoke 统一事务：UPDATE（可 0 行）后无条件走 `trackCleanup` | 恢复"UPDATE 0 行即返回" → 并发补建段红 |
| 更正驱动 revokeVersion 不建清理事实/通知 | `revokeVersion` 事务内 UPDATE RETURNING 后逐行 `trackCleanup` | 跳过 trackCleanup → `correction_revocation_creates_cleanup` 红 |
| #725 围栏测试并未压到"权威行已取回、交付围栏未跑"窗口 | 新增 `delivery_fence_covers_post_index_window`（挂第一次来源核验） | isShared 去 revoked_at 条件 → 围栏用例红 |
| 浏览器 e2e 未区分"待发送"/"已发送待回执" | web-stack 加仅测试 `POST /test/dispatch`；e2e 两态都断言 | —（文案层面，由 e2e 直接实证） |

## 3. #726 实施要点（d216808）

- 服务：`MemoryService.forget`（404 他人/不存在；幂等按 subject+memoryId；事务内 version_basis 闭包置 forgotten、收回活跃共享、scopes、memory_cleanups、逐应用通知）与 `createSourceService.revokeSource`（幂等同理，闭包置 revoked、取消 accepted/pending 提取并清片段、scopes 含 extraction）。
- 清理视图：share_cleanups ∪ memory_cleanups（kind 三态），通知直接携带 consumer_app_id；outcome 派生（无回执 awaiting_receipt；有回执 uncontrollable > completed > partial）。回执只认应用服务身份，completed 须逐项 evidenceRef。
- 合同：`CleanupStatusView` 扩展 kind/memoryId/sourceRef/notifications/scopes；sourceRef 按合同存单对象（测试首跑发现数组形态偏差，已修）。
- UI：`/sources` 独立页（来源撤销）、记忆卡两步内联遗忘确认（不用 window.confirm）、清理行三类 kind 文案 + "无接收应用需要通知"分支。
- 验证：7/7 单元（端口 4242 / 库 openbot_memory_test_726）；浏览器 e2e 追加遗忘+来源撤销两段（需先 `bun run build` 再跑，web 栈服务 app/dist）。

## 4. #726 审核 finding → 修复记录（b89b2d3）

审核 15 confirmed 去重 4 类（4 名 finder 独立复现）。修复与变异验证：

| finding | 修复 | 变异验证（已还原） |
|---|---|---|
| (high) revokeSource 幂等早退吞掉后续撤销：重连后新 confirmed 版本永久免疫再次撤销 | 去掉事务外 check-then-act；闭包重跑（只碰 confirmed），`memory_cleanups` 部分唯一索引 `(subject_id, source_ref) WHERE kind='source_revocation'`，ON CONFLICT DO NOTHING 回读后并入 version_ids/scopes 去重合并，句柄稳定 | 恢复事务外早退 → `repeat_revoke_after_reconnect` 红 |
| (medium) 来源撤销不取消 processing 在途提取：候选照常形成 | 取消 UPDATE 覆盖 `processing`；`processIngestion` 候选落库前重验租约仍归本 worker（防陈旧 worker 写回） | 去掉 processing → 场景 A 红；去 still-leased 守卫 → 场景 B 红 |
| (medium) forget 空闭包返回从未落库的 cleanupId（悬挂句柄、重试不收敛） | 空闭包也落行（version_ids='[]'）；部分唯一索引 `(memory_id) WHERE kind='forget'` + ON CONFLICT 回读，重试返回同一 id | 恢复 `if (!versionIds.length) return` → 幽灵句柄与并发用例红 |
| (medium) 并发双 forget / 双 revokeSource 各自 check-then-act | 幂等检查移入事务（唯一索引兜底）；并发 N=8 收敛同一句柄、一行清理事实 | ON CONFLICT 收敛被并发用例覆盖 |
| (high) cleanup outcome=completed 而第二个消费者未回执 | outcome 改为「全部通知都有回执才派生」：缺任一回执 → awaiting_receipt | 恢复旧 flatMap 逻辑 → `outcome_completed_requires_all_receipts` 红 |

## 5. #728 实施要点（内容保留与恢复）

- 服务：`src/retention/sweep.ts`（24h 片段清除兜底、30d 排队过期清片段、30d review 候选删除、Hindsight/备份适配器各自 try/catch 进 errors，逐归属幂等可重试）、`src/recovery/gate.ts`（recovery_gates replaying→done）、`src/recovery/replay.ts`（持久撤销日志 `recovery_revocation_log` 逐条重放：版本压回终态、共享收回、清理事实+通知按 cleanup_id 幂等重建；索引清除成功后**才**标 replayed_at，失败保持 pending 可重试）。
- recall 闸门：入口（不发起来源核验）+ 交付 barrier 各检查一次，replaying 一律 `state=unavailable, unavailableReasons=["recovery_replaying"]`。
- DDL：recovery_gates、recovery_revocation_log（独立于业务备份的持久撤销日志）。
- 验证：5/5（端口 4244 / 库 openbot_memory_test_728）；六条变异（保留窗口、备份失败隔离、hindsight 清除调用、recall 入口/barrier 两处闸门、索引重放）全部杀死目标测试。

## 5b. #728 审核 finding → 修复记录（533bb75）

审核 12 confirmed（4 维度 finder + 双 lens 对抗核验，去重 7 类）。修复与变异验证：

| finding | 修复 | 变异验证（已还原） |
|---|---|---|
| (medium) 崩溃 worker 留下的 `state='processing'` 任务逃出全部保留规则，完整片段可无限期留存 | 30 天过期规则纳入 `processing`（租约接管窗口就是租约本身，绝对上限照旧） | 去掉 processing → 崩溃残留用例红 |
| (medium) 已 done 的 restore_id 再 open 是 no-op，pending 未重放期间召回仍开放 | `gate.open` 改 `ON CONFLICT DO UPDATE SET state='replaying', replayed_at=NULL` | 恢复 DO NOTHING → 重开闸门断言红 |
| (high) 持久撤销日志没有写入方：任何恢复都重放空集，撤销内容全部复活 | 新增 `src/recovery/log.ts`；`forget`/`revokeSource`/`revoke`/`revokeVersion` 同事务追加日志行（restore_id 留空，重放时认领） | 去掉 forget 写入 → 重放用例红 |
| (high/medium) cleanup_id 为 NULL 的日志重试每次新 UUID，撞 `memory_cleanups_*_uidx` 唯一索引 → 重放永久抛错、闸门关死 | 重放 INSERT `ON CONFLICT DO NOTHING` + 按自然唯一键（memory_id / subject_id+source_ref / authorization_id）回读收敛 | 改回 `ON CONFLICT (id)` → 无句柄重试用例红 |
| (medium) share_revocation 重放把版本压终态、收回全部接收方、且从不重建共享清理 | 与本人撤销共享对齐：版本不动，只收回日志点名的接收方，重建 `share_cleanups` + 通知 | 恢复版本压终态 → 共享重放用例红 |
| (medium) sweep 的本地 SQL 步失败不被隔离（整体抛出、外部适配器一并跳过） | 每步 `step(name, fn)` try/catch 进 errors，后续步骤与适配器照常执行 | 改写为直接 await → 隔离用例红 |
| (medium) `purgeVersions` 可选 → 适配器缺方法时静默当作清除成功 | 类型改为必需方法；重放时缺适配器直接抛错、不标 replayed_at | 类型层强制（无运行期变异点） |
| (low) 30 天排队清片 `payloadsDeleted` 计 0 | 过期步的 RETURNING 计数并入 | 并入被崩溃残留用例覆盖 |
| (low) rejected/expired 候选正文永不清理 | 候选删除覆盖 `review/expired/rejected` 三态 | 三态删除被崩溃/候选用例覆盖 |
| (low) `sweepRetention` 无生产触发点 | `src/index.ts` 启动一次 + 每小时（错误进结果并打日志） | 生产接线，无测试变异点 |

## 6. #727 审核 finding → 修复记录（c12cb30）

审核 10 confirmed 去重 6 类。修复与变异验证：

| finding | 修复 | 变异验证（已还原） |
|---|---|---|
| (high) reserved 复用无互斥 + 无法区分「execute 前/中崩溃」 | 新增 `dispatched_at`；execute 前原子认领 `reserved→unknown`（`WHERE state='reserved' AND dispatched_at IS NULL RETURNING`），失败即 AlreadySettled；reserved 从此唯一地表示「execute 从未开始」 | 认领去守卫 → 并发复用用例红；复用路径跳过认领 → 同一用例红 |
| (high/medium) 已结算提取被闸门失败丢弃 → 永久 pending(already_charged) | `ingestion_jobs.extraction` 持久化提取结果，阶段 5 优先复用（不重调网关）；finish 的 pending 分支用 `CASE WHEN terminal THEN NULL ELSE extraction END` 保留库内现值（本轮曾踩旧值覆盖）；终态/候选落库/来源撤销/#728 sweep 均清 extraction | 去掉复用分支 → 复用用例红 |
| (medium) settle 未校验 actualMicrousd | `0 ≤ actual ≤ maximum` 才结算，否则按 unknown 保留 maximum 占用 | 去掉校验 → 谎报费用用例红 |
| (medium) 超大十进制 limit 溢出 bigint → 500 | wire 校验转 BigInt 并判 `> 2^63-1` → 400 | 去掉上界 → 用例红 |
| (low) 运营者断言用错身份 | 改为 bob 记忆跨主体不可见（alice 本人列表不含、bob 自己的列表含） | —（断言自证） |

## 6b. #715 实施与验证记录（IDENTITY 514143c / OpenBot 4e52125b6）

- IDENTITY：`src/subjects/registry.ts`（resolveSubject/subjectStatus/setStatus，不按邮箱查询或创建）、`legacy-import.ts`（受控旧映射导入：subjectId=legacyUserId 保留历史 id、幂等、冲突拒绝切换）、`routes.ts`（`POST /internal/subjects/{resolve,status,legacy-import}`，Bearer 定长比较；未配 `IDENTITY_INTERNAL_TOKEN` 整组不挂载）、DDL/schema 两张表、config 增 `internalToken`/`allowLegacyImport`。
- OIDC 闸门：authorize（授权前）与 token（签发前）各查一次中心状态——停用 → `access_denied` / `invalid_grant`；中心不可用 → `temporarily_unavailable`（授权）/ 503（token），不签发任何凭据；未登记主体按首次登录放行。
- OpenBot：`server/src/auth/subject-projection.ts`（`projectVerifiedSubject` 只认中心 SubjectRef，先取中心当前状态再 `ensurePrincipal`；`resolveCenterActor` 会话 → 中心主体 → actor；`createCenterStatusClient` 内部 API 客户端）、config 增 `IDENTITY_CENTER_INTERNAL_TOKEN`（可选，配了却无 sign-in 配置则启动拒绝）、`.env.example` 文档。
- 用例：IDENTITY `tests/issue-715.test.ts` 6 用例（`internal_api_auth`/`legacy_ids_and_resources`/`same_email_no_link`/`mapping_conflict_and_outage` 两段/`disabled_and_scope`），独立库 `openbot_identity_test_715`，该文件用 `describe(..., { serial: true })` 串行化（e2e 的 suite 实例按 realm 重建，同库并行会互相 TRUNCATE）。
- OpenBot `server/tests/identity-center-continuity.test.ts` 6 用例：真实身份中心子进程验证内部 API（未知主体 → null、令牌错 → 拒绝）+ 合同夹具 store 上的四场景投影判定。
- 变异（已还原）：ownership 校验、授权停用闸门、中心不可用 fail-closed、内部 API 认证、token 停用闸门、legacy 保留 id、legacy (issuer,subject) 冲突、投影 status 前置、generation 校验、actor 停用判定 —— 全部杀死目标测试。
- 未接线：请求路径尚未装配 `createSubjectProjection`（等 #733 组合验收或启用 identity-center 的部署接线）；OpenBot 企业测试库 5435 未运行，投影的 drizzle store 只经类型检查，未做数据库集成验证（票面允许具名合同夹具，集成阻塞已记录）。

## 6c. #730 与 #729 实施与验证记录

### #730（OpenBot c3475e779）
- `server/src/memory-service/source-check.ts`：OpenBot 签发来源引用（HMAC 标签 `memory-source`），每次采集/召回/审核前在线裁决——验签与主体/来源绑定 → 接收应用 active（`unknown_consumer`）→ 本人对该动作的委托（`delegation_required`）→ Access（`source_revoked` / `unavailable`）→ 版本归属（`forged_scope`）。浏览器/频道/定时入口同一策略，无入口专属放宽。
- `client.ts`：逐请求由 `ServerCredentialProvider` 签发服务凭据与本人委托，身份只走头部；`MemoryServiceError(status,code)` 不把拒绝当空结果。`context.ts`：装载器按运行归属签发来源引用，不可用时不注入内容并保留 `RecallResult`。`routes.ts`：`POST /api/memory-service/source-check`，服务令牌定长比较 + 形状校验。
- 用例：来源裁决 5 用例（伪造作用域/未知接收应用/三入口同策/来源不可用/端点鉴权）；运行时 4 用例（真实 HTTP、逐请求凭据、403 映射、partial/unavailable/故障装载）。
- 变异（已还原）：验签旁路、consumer active 判定、委托判定、版本归属判定 —— 全部杀死目标测试。
- 未接线：`createOpenBotMemorySourceCheck` 与真实企业 Access/应用登记 store 的装配（企业测试库 5435 未运行，票面允许具名 fixture）。

### #729（MEMORY fc7f9a6 / OpenBot e43f3a34a）
- MEMORY Task 1：索引失败不再使召回 500——回退权威表回读并沿用同一组授权过滤（本人/委托/共享/有效区间/依据 revision），降级事实以 `index:unavailable` 明示；确认事务提交后 `syncIndex` 写索引、失败吞掉，幂等重复确认分支复用（索引恢复后补写）。既有 `recall-isolation` 中"索引抛错 → 503"的断言按本票语义更新为 200 + `partial`（授权类失败仍 503）。
- OpenBot Task 2：`memoryContextBlock`（服务故障 → 普通对话继续并注入"本次未使用记忆"提示；依赖记忆的任务暂停）；`copilot.ts` 新增 `setMastraMemoryContext` 接缝——装配后**替代**旧 #395 装载器，服务故障时绝不回落旧存储（no_legacy）。`submitWithIdempotentRetry`：只有网络错误/超时/5xx/429（没有可靠回执）重试且复用同一幂等 key，4xx 不重试；`timeoutMs` 可选（默认不设）。
- 用例：MEMORY `tests/recall-fallback.test.ts` 4 用例（fallback_filters/partial_source/confirm_before_index + 空匹配 available）；OpenBot 原生 `memory-service-degradation.test.ts` 4 用例（plain_chat_and_required_task 两段、submit_retry、no_legacy）；Bun 驱动 `mastra-memory-service-degradation.test.ts` 3 用例（普通对话提示且旧存储零读取、依赖记忆任务在任何模型调用前暂停、正常内容经服务装载进 prompt）。`tests/config/e2e-bun-suites.json` 手工登记该 Bun 文件（`server/tests part 10` 首位），原生 e2e 报告确认收集 `memory-service-degradation.test.ts`（4/4）。
- 变异（已还原，全部杀死）：索引失败改回抛错、禁用 `syncIndex`、丢弃 partial 原因、忽略 `required` 判定、重试换 key、4xx 也重试、删除 `MEMORY_UNAVAILABLE` 暂停、服务故障静默回落旧存储（组合变异）。
- 未接线：`setMastraMemoryContext` 的生产装配（等 #733 组合验收；装配后旧 Hindsight 装载器不再使用，但在所有消费者切换前不删除旧实现，符合票面约束）。

### #729 审核（18 findings → 4 confirmed，去重 3 类）与修复轮 fefd3c1ed
- **manifest 完整性（high）**：Bun 驱动套件只登记进组、未进顶层 `files`，`committed_manifest_files_equals_flatten_groups` 会失败且原生收集不会排除它 → 补顶层条目；`tests/e2e-manifest-contract.test.ts` 8/8 绿。
- **basis 半解析（medium）**：记忆服务装载器渲染 `- 正文`，`parsePersonalMemoryBasis` 永远返回空，装配后会静默丢失 FIX-W14 回答依据 → 改为**新 seam 不写 basis**（`MemoryView` 无 kind、id 也不是 #387 证据 id，半解析等于冒充依据），代码注释与本节明确记录；服务记忆的 basis/证据语义留待 #733 决策。
- **no_legacy 恒真（medium）**：node 侧两个"计数桩"从未接入被测代码，断言不可能失败 → 删除桩，改为"故障只问一次服务、内容逐字来自响应"；真实"旧装载器零读取"证据在 Bun 接线套件（装配旧+新装载器，旧计数 0）。
- 修复后复验：原生 13/13（degradation 4 + runtime 4 + source-check 5）、Bun 13/13（含旧 #479 10 用例）、manifest contract 8/8。

### #731 实施与验证记录（MEMORY ecdcc6f / OpenBot da8a46b0c）
- MEMORY：`app/src/embed/channel.ts`（仅四种合同消息，字段 type/requestId/height；目标 Origin 取 `document.referrer`，剥离即不启用）、`app/src/embed/session.ts`（401 → 内嵌发 auth-required / 独立走 BFF 顶层）、`app/src/routes/logout.tsx` + BFF `GET /auth/logout`（清会话 cookie，不复活撤销委托）；三处页面 401 分支改走统一入口。
- OpenBot：`server/src/memory-service/entry-routes.ts`（`GET /api/memory-service/entry` → `{entry:{src,allowedOrigin,requestId}}`，仅会话本人，地址与 Origin 只来自部署配置）、config `MEMORY_SERVICE_URL`（fail-closed 校验）、assembly 挂载（未配置则整组不挂载）；`app/src/lib/memory-service/queries.ts`、`app/src/components/memory-service/frame.tsx`（Origin+source window+requestId 三件齐备才处理；auth-required 只做顶层 `/memory` 回跳，消息地址丢弃；sandbox 不含 allow-top-navigation）、`/memory` 改为承载页（保留 `_app` 侧栏）、侧栏新增入口、`LEGACY_PAGES` 去掉 `/memory`、Bot 记忆页链接改为 `/memory`。
- 用例：app 4 用例（wrong_origin_or_window_is_ignored / auth_message_cannot_choose_return_url_or_user / logout_clears_embedded_state / frame_keeps_sidebar_and_has_no_second_navigation）；server entry 3 用例（未登录 401 / 形状与唯一 requestId / 子路径保留）；MEMORY 3 用例（承载上下文 fail-closed / 消息字段与目标 Origin / 高度只在变化时为正值）。
- 变异（已还原，全部杀死）：去掉 Origin 校验、去掉 source 校验、去掉 requestId 校验（app 套件分别 2/2/1 红）、目标 Origin 改 `"*"`（MEMORY 套件 2 红）。
- 浏览器验收 **blocked**：`tests/e2e/better-auth/web/memory-service.e2e.ts` 已在 `tests/config/e2e-engine-suites.json` 的 better-auth-web 组登记，`e2e list` 收集到 6 个用例；实际运行因 `BA_E2E_APP_ORIGIN` 未设置被 preflight 在配置加载处拒绝（零导航），本机无 Better Auth/Casdoor 栈。票面要求记录浏览器版本与存储策略——未执行即无此证据，不列为支持。
- 未接线：`setMastraMemoryContext` 生产装配、`MEMORY_SERVICE_URL` 的实际部署值（本地无记忆服务实例运行）。

### #731 审核（25 findings → 9 confirmed，去重 6 类）与修复轮（MEMORY feb8455 / OpenBot feba5c45a）
- **auth-required 无穷重载（high，2 条同源）**：默认处理只 `location.assign("/memory?login=1")`，无人消费该参数，也从未顶层启动 MEMORY 的 `/auth/login`；MEMORY 回调只回自己的 `/` → 任何一次内嵌 401 都会让宿主无限重载。修复：frame 默认顶层导航到 `${allowedOrigin}/auth/login`；MEMORY 新增 `MEMORY_EMBED_RETURN_URI`（服务端配置，登记承载路由），回调后跳回该地址；会话仍建立不起来时第二次 auth-required 停止并显示说明（不再重载）。
- **任意站点可加框（low）**：MEMORY 接受任意 http(s) referrer 为宿主且无 frame-ancestors → 任意站点可嵌入管理站。修复：`MEMORY_EMBED_HOST_ORIGIN` 配置驱动 `Content-Security-Policy: frame-ancestors`（未配置即 `'none'`），页面从注入的 meta 取白名单，referrer 必须精确等于它才建立渠道。
- **logged-out 无操作（medium）**：承载页未传 `onLoggedOut`，退出不清内嵌状态。修复：frame 自身在 logged-out 时清除内嵌界面并显示"已退出"。
- **默认分支无覆盖（medium）**：测试只走回调分支（页面实际不传回调）。修复：新增 `default_login_goes_top_level_once_and_stops_instead_of_reloading`（注入 navigate，断言目标为 `/auth/login`、第二次不再导航并显示提示）。
- **浏览器套件 vacuous（medium）**：`restricted_storage` 未施加任何限制、`sidebar_and_same_owner` 的 Origin 断言可被跳过、`return_url` 登录的是 OpenBot 而非记忆服务。修复：删除无夹具的 `restricted_storage` 用例并在文件头声明该 A 项 blocked；Origin 缺失改为失败；`return_url`/`logout_revocation` 改为断言记忆服务 `/auth/login` 与 `/auth/logout` 流程。
- **覆盖审计无法验证 engine 登记（low）**：`e2e-coverage-audit.mjs` 在本仓既有 bun-manifest 契约失败处先退出，未到 engine 清单。记录为既有债，不改。
- **入口"不挂载"半边未测（low）**：`/api/memory-service/entry` 只在 `memoryService` 配置存在时挂载，测试未断言未配置时的 404。记录为已知缺口（挂载条件在 `assembly/http.ts` 单行 `if`）。
- 修复轮变异（已还原，全部杀死）：去掉宿主白名单（MEMORY 1 红）、去掉登录循环保护（app 1 红）。
- 修复轮复验：app 5/5、server entry 3/3、MEMORY 全量 155/155、app/server/MEMORY typecheck 与 app/MEMORY build 全绿。

### #731 浏览器验收（2026-10-31，五进程真实栈，blocked → 通过）
栈：IDENTITY `:4210`（RS256 + better-auth 表单，`/tmp/731-identity.env`）+ MEMORY `:4230`（`/tmp/731-memory.env`，OIDC 指向身份中心，`MEMORY_EMBED_HOST_ORIGIN=http://localhost:3010`、`MEMORY_EMBED_RETURN_URI=http://localhost:3010/memory`）+ OpenBot server `:3002`（`.env` + 覆盖层 `MEMORY_SERVICE_URL=http://localhost:4230`）+ vite `:3010`（`SERVER_PORT=3002`）+ agent-browser（Chrome 1.4.2 CDP）。浏览器逐用例执行 `tests/e2e/better-auth/web/memory-service.e2e.ts` 的五个用例（引擎套件本身仍需 BA 栈才可运行，此处为同一断言集的手工真实浏览器执行）：

| 用例 | 结果 | 证据 |
|---|---|---|
| sidebar_and_same_owner | 通过 | 侧栏 Bots/技能/插件包/Craft/记忆 全在；iframe `title=记忆` 可见；`src=http://localhost:4230/?embed=1&requestId=<uuid>`，Origin 等于 MEMORY_SERVICE_URL；iframe 内渲染记忆管理界面（暂停控制/待审核候选/已确认记忆/清理状态） |
| return_url | 通过 | 未登录记忆服务时 auth-required → 顶层 `/auth/login` → `:4210/oauth2/authorize`（PKCE S256）→ 身份表单 → callback 置 `memory_session` → 302 returnUri 回 `/memory`（回跳后 OpenBot 自身门禁因下述 cookie 撞名跳 `/sign`，重登 OpenBot 后 `/memory` 显示带会话的承载页——回跳到达与终态均有实证） |
| deep_link | 通过 | 刷新 `/memory` 后 URL 不变、iframe 仍在，高度 595px（`memory.resize` 通道生效，MIN 480 之上按内容调高） |
| logout_revocation | 通过 | `:4230/auth/logout` 后 `memory_session` 消失；回 `/memory` → iframe 401 → auth-required → 顶层要求重新登录，承载页不再可见 |
| message_origin | 通过 | 伪造 `{type:memory.auth-required, requestId:"forged", returnUrl:"https://evil.example/steal"}` 被忽略：URL 不变、iframe 不动、不跳转 |

- **验收发现并修复真 bug（high）**：承载页入口 `/?embed=1&requestId=…` 由 `serveStatic` 直接命中根路径 index.html，绕过 SPA 回退里的 `<meta name="memory-embed-host">` 注入——白名单到不了页面，渠道建立不了，登录落回 iframe 内部跳转（浏览器首跑即暴露：iframe 里出现身份表单而顶层 URL 未动）。修复：`src/http/static.ts` 在 serveStatic 前显式应答 `GET /`（与回退同一份 `indexHtml()`）。回归测试 `tests/static-embed.test.ts`（2 用例；`hono/bun` 只有 Bun 运行时可导入，沿用 web-stack 先例 spawn bun 对真实路由顺序断言），先红后绿，移除修复行变异复红、还原复绿；MEMORY 全量 157/157。
- 环境事实（非产品缺陷，部署须知）：①OpenBot 与身份中心都是 better-auth，cookie 同名 `better-auth.session_token` 且 cookie 不分端口——同 host 不同端口的本地拓扑里登身份中心会覆盖 OpenBot 会话（双向互踩，静默 SSO 链随之失效）。**已修复（IDENTITY 47f3265）**：身份中心 better-auth 设 `advanced.cookiePrefix: "oba-identity"`，两会话罐不再相触；真实验证：登 OpenBot → 点记忆 → 首触输一次身份密码 → 回 `/memory` 带承载页且 OpenBot 会话不丢；仅退记忆会话 → 再点记忆 → 静默 authorize 全链无表单回 `/memory`。identity 套件 10/10。生产各服务独立主机（host-only cookie）本就不撞，该前缀对自托管单主机多端口部署是纯增益。②`memory_session` 为 `SameSite=Lax`：承载页与记忆服务同站（同一注册域/同 host 不同端口）时会话可承载，跨站托管不在 v1 支持范围（与 restricted_storage 声明 blocked 一致）。
- 票面的浏览器版本与存储策略证据：Chrome（agent-browser CDP 驱动，Bun 1.4.2 环境报告）；存储策略=同站 Lax 会话 cookie + iframe sandbox `allow-scripts allow-same-origin allow-forms allow-popups`；restricted_storage（受限第三方存储）仍无夹具、维持 blocked。

## 7. 债与已知边界

- `#726 观察范围`：memory_cleanups.scopes 暂无 `observe:` 段，待 #730 真实索引接入后补录。
- 更正路径的 revokeVersion 现已建清理；revoke_intents 重放保持（远端故障不丢撤销）。
- 回调投递超时 5s / 重试周期 60s 为 v1 常量；`processing` 租约任务不强行取消（由完成路径自然落终态）。
- 来源撤销幂等查询命中后可返回旧 cleanupId，即使其后有新 confirmed 版本——新内容需新采集与新审核（票面语义），既有清理不再重复通知。
- 浏览器 e2e 依赖 `app/dist` 最新构建；未 build 会静默跑旧界面（本轮曾踩，已记录）。
- 环境事故（本轮）：42xx 端口泄漏 16 个残留 bun identity 进程（kill）；55470 测试库容器被连带清掉（openbot-test-pg/openbot-postgres-1/agent-computer 同批 Exited 255），已用 `docker run --name openbot-test-db-55470 -p 127.0.0.1:55470:5432 postgres:17-alpine` 重建并补建 `openbot_memory_test`/`openbot_identity_test`；`tests/oidc-provider.test.ts` 原用硬编码容器名 `memory713-pg` 已改为走连接串。
- OpenBot 企业测试库 5435 当前未运行；依赖它的 server 集成套件本轮无法验证（#715 投影 store 因此改用合同夹具）。
- `#732` 用户裁决（2026-10-31）：① 旧 `personal_memories`/`memory_sources` 行不提供导出/清理/自助更正入口，只读保留（除非另行授权的生产清理）；② 恢复默认开启，但只恢复后台研究：新 `server/src/proactive/defaults.ts`（采用/共享锁/退出行）、`config.proactiveDefaults`（`OPENBOT_PROACTIVE_DEFAULTS`，on-unless-off）、proactive store `remove` 与 Bot reset 恢复写 `default_opt_outs`；记忆源默认不恢复（`OPENBOT_MEMORY_SOURCE_DEFAULTS` 留在历史里）；③ 授权提交/推送/改票与 #733 四站环境。
- 仍开放：`POST /api/memory-service/source-check` 已实现未挂载（服务令牌来源待与真实 MEMORY 实例对齐，#733 联调）。
- 复审新增债（2026-10-31）：① `server/src/hindsight/degraded-recall.ts` 零生产 import，仅 `hindsight-degraded-recall.integration` 与 `hindsight-answer-evidence.integration`（facade 断言）引用，删除需先改写后者的 5 处 facade 调用；② `server/src/enterprise/tenancy/personal-memory.ts` 零生产 import（既有债，非 #732 回归），仅 multitenancy 测试消费；③ runtime 仍构造 `hindsightBudgetGate`/`hindsightSyncQueue` 并注入偏好/来源召回服务的写臂，evidence seam 只读路径不触发它们，属构造签名惯性；④ `docs/plans/2026-10-23-issue620-modular/MOD25-redirectable-set.json` 含已删 `memory/routes.ts` 的历史对（mod25 D1 只读排序后前 12 对未触发 ENOENT，勿再重排/前移）；⑤ copilot 的 `required` 名单（`recall_personal_memory`/`forget_personal_memory`）恒 false，#733 新增记忆工具必须同步该名单（已在代码注释钉住）。

## 8. #732 实施完成 + 审核 finding 修复完成（待复审）；#733 blocked

### #732 消费者盘点（票面第一步，仅盘点，不构成行为证据）
命令（仓库根，2026-10-31）：
`rg -n 'createMemoryStore|createHindsightRecallArm|createHindsightSyncArm|setMastraPersonalMemoryContext' server/src app/src`

| 旧调用 | 位置 | 当前去向 | 切换后目标 |
|---|---|---|---|
| `createMemoryStore` / `memory` 装配 | `server/src/assembly/runtime.ts`（10 处） | `/api/memory` 路由族（`assembly/http.ts:2950`，按 `coworker.memory` 挂载） | 不挂载；记忆写入只经记忆服务 |
| `createHindsightRecallArm` / `createHindsightSyncArm` | `runtime.ts`（10 处，含 `hindsightSyncArm.sweep` @4897） | 运行期上下文装载（`setMastraPersonalMemoryContext(hindsightRecallArm.renderedLoader)` @4862）+ 后台同步队列（`hindsight/sync-queue.ts`） | `setMastraMemoryContext`（#729 已建 seam）+ 记忆服务采集；旧 sweeper 停用 |
| `setMastraPersonalMemoryContext` | `server/src/copilot.ts`、`server/src/memory/integration.ts`（6 处） | ME07 运行路径（#479）与 headless 路径 | 新 seam 装配后旧 seam 不再被读（#729 已测零读取）；旧实现待消费者全部切换后删除 |
| `/api/hindsight` 路由族 | `assembly/http.ts:2984` | Hindsight 自有接口（#387–#391） | 记忆消费者切换后停挂；非记忆职责（证据 seam、观察）先按原行为独立保留 |
| 浏览器旧写入 | `app/src/lib/memory.ts`（`/api/memory`、`/api/memory/sources`、`/api/memory/pause-controls`、`/api/memory/hindsight/status/batch`）、`app/src/lib/hindsight/{queries,mutations}.ts` | 旧 settings/Bot 记忆界面 | 管理只经 #731 承载页 |
| 后台作业 | `hindsightSyncArm.sweep`、`server/src/proactive/*`（`store.ts`/`engine.ts` 读记忆默认与共享限制）、`server/src/agents/lifecycle-reset.ts` | 记忆再索引 / 主动任务默认 / Bot 重置 | 记忆调度停用；proactive 非记忆行为保留（#732 `other_lifecycle`） |

### 实施结果（2026-10-31，本地工作区 `memory-service-713`，未提交）

**服务端**
- 删除旧实现：`server/src/memory/{tools,store,routes,public,integration,ingestion,defaults,company}.ts`、`server/src/hindsight/{legacy-migration,health,cleanup-evidence,backup-registry,ops-view,routes,personal-memory-context}.ts`。保留 `memory/{types,sensitivity}.ts`（schema 与 sensitivity-gate 依赖）与证据 seam 传递依赖的 hindsight 模块（`answer-evidence`、`bank-scope`、`judgment-review`、`derived-judgments`、`preference-recall`、`scoped-recall`、`sync-queue`、`revocation`、`revocation-ledger`、`budget-gate`、`restore-recovery`、`pause-controls`、`sensitivity-gate`），它们只被 `createAnswerEvidenceService` 的装配使用，不再挂路由/调度。复审后另删两个零生产消费者的孤儿：`hindsight/config.ts`（隐私校验，随 health 一起退出）与 `hindsight/health.ts`（前轮已删）；`degraded-recall.ts` 零生产 import、仅两个测试引用，见 §7 债条。
- `copilot.ts`：唯一运行 seam 为 `setMastraMemoryContext`（记忆服务）；删除 `MastraPersonalMemoryLoader`/`setMastraPersonalMemoryContext`、旧中间件挂载与 answer-basis 写回。
- `assembly/runtime.ts`：`/api/memory` 与旧 recall/sync 臂、记忆默认、`memory:` 工具目录与派发、coworker.memory 对象、sync/记忆 sweep 生命周期全部移除；新增 `MEMORY_SERVICE_*` 配置下装配 `createMemoryClient` + `createMemoryContextLoader` 并为 headless 面提供同一 loader；headless 面用 `memoryContextBlock({required:false})`（服务故障注入诚实提示，不失败回合）。
- `assembly/http.ts`：不挂 `/api/memory`；`/api/hindsight` 仅保留 `POST /evidence`（证据巡检），其写入口与后台作业不再存在。
- `agents/lifecycle-reset.ts`：reset 不再选择/删除 `memory_sources`、`personal_memories` 或写退出标记；计数保持 0，其余非记忆职责（会话、routines、职责、跟进、研究设置、常驻许可）行为不变。
- `proactive/engine.ts`+`store.ts`：移除 `form_memory` 工具/提示/计数与记忆默认、共享限制读取；`agent-resolver.ts` 移除旧装载器参数；`audit.ts` 移除已无写入者的 `memory.sensitivity_refused`。
- `config.ts`：`MEMORY_SERVICE_URL` 配置时 `MEMORY_SERVICE_APP_ID/APP_SECRET/SOURCE_KEY` 三者必填，缺一即拒绝启动（fail-closed）。**合同变化**：#731 部署契约由“仅 URL”收紧为四值同配。

**浏览器**
- 旧 settings 记忆页删除，`/settings/memory` 改为受控重定向到 `/memory`（#731 管理承载页），settings 侧栏“记忆”直达 `/memory`。
- 删除旧写/读组件与客户端：`components/memory/{memories,pause-controls,sources,judgment-review,cleanup-progress}.tsx`、`lib/memory.ts`、`lib/hindsight/{mutations,sensitive-refusal}.ts`；`lib/hindsight/queries.ts` 收敛为证据巡检一项；`client.ts` 移除 `/api/memory` 作用域声明。
- `components/memory/evidence.tsx` 改只读（保留按现行授权逐行复核的展开，移除更正/遗忘写入口及其确认对话）；`answer-basis.tsx` 只保留聊天回答面；聊天文案随 openbot-copy 改写。
- Bot 记忆页移除来源列表，保留后台调研设置并指向 `/memory`；Bot 设置行摘要改为只反映后台调研。

**测试与清单**
- 新增 `server/tests/memory-service-no-legacy.test.ts`（5 用例）：证据巡检 200 且旧面孔 404、copilot 只导出新 seam、旧 store 模块不可装载、reset 保留旧记忆行并照常清 routines（plan 记 0）。
- 删除旧行为套件 28 个（server 25 + app 3），裁剪 `package-entrypoints`（(e) 记忆采集）、`proactive-store`（两条记忆形成用例）、`proactive.test.ts`（form_memory 断言）、`web-memory-routines`（仅保留 routines）、`memory-answer-basis`（增加“只读，无更正/遗忘按钮”断言）、`mastra-memory-service-degradation`（去掉旧装载器对照臂）。
- `tests/config/e2e-bun-suites.json` 同步删除对应 entries/causes；`memory-service-no-legacy` 独立成组（避免与 enterprise 库绑定的 24 文件切片同跑）。

### 验证证据（2026-10-31，本机）

| 套件 | 结果 |
|---|---|
| `E2E_BUN_ONLY=memory-service-no-legacy`（driven） | 1/1 组通过（内部 5/5 用例），退出码 0 |
| `E2E_BUN_ONLY="app/tests part 1"` / `"app/tests part 3"` / `"app/tests/multitenancy"` | 3 组全绿（bot-memory 2、memory-answer-basis 6、web-memory-routines 3） |
| `E2E_BUN_ONLY="server/tests part 7"`、`part 14`、`server/tests/package-entrypoints` | 全绿（含 answer-evidence、pause-controls、proactive-store、package-entrypoints） |
| 原生：memory-service-{runtime,degradation,source-check,entry} | 16/16 通过 |
| 原生：bot-lifecycle-{routes,audit,watcher}、proactive.test、audit.test、agent-routes、identity-app-wiring、self-host-banner、request-tracking、gateway-readiness-gate | 全绿（audit 首轮因 taxonomy 残留红 1 项，随 `memory.sensitivity_refused` 移除转绿） |
| `mastra-memory-service-degradation`（bun 直跑，诊断） | 3/3 通过；其所属 part 10 受企业库 5435 未运行阻塞 |
| `tests/e2e-manifest-contract.test.ts` | 10/10 通过（files==groups、分组不移动、BA 批次约束） |
| `server` `tsc --noEmit`、`app` `tsc --noEmit`、`app` `vite build` | 全绿 |
| Biome（本轮改动文件） | 0 error |

未验证 / 阻塞：
1. `server/tests part 2`（含 `attachment-routes`）与 `part 17`（含 `shared-wiring.integration`）分组运行耗时过长/未完成，按“不可验证不冒充实测”记为未完成；相关文件不在本轮删除清单内。
2. 依赖企业测试库 5435 的套件（`part 10` 等）本轮不可运行。
3. 独立 reviewer（未参与实施会话）的行为验收与 Spec/质量审核尚未进行——按完整档要求，冻结检查点后另行安排。
4. `all_surfaces`/`outage_no_legacy` 的真实四站集成证据属于 #733 验收执行器范围；本轮以行为单测与装配事实为证据，不冒充端到端。

### 8b. 独立审核 finding 与修复轮（2026-10-31）

独立会话审核返回 13 条 finding（F1–F13）。逐条处置：

| # | 结论 | 处置 | 证据 |
|---|---|---|---|
| F1 | 确认 | 清掉 `runtime.ts`/`copilot.ts`/`ops-routes.ts` 未用导入与变量（含 `HINDSIGHT_SYNC_DRAIN_INTERVAL_MS`、degraded 搜索构造、`hindsightJudgments`），修复被打乱的 biome-ignore 与注释 | 48 个改动文件 biome 0 error |
| F2 | 确认 | Bot 设置行摘要改用 `researchSummary`（已在本轮前修复） | `bot-settings-rows` 7/7 |
| F3 | 确认 | 工具访问普查去掉 `memory/ingestion.ts` 条目（已修） | `tool-access-public` 28/28 |
| F4 | 确认 | web-copilot 普查去掉已删组件（已修） | `web-copilot-scope` 14/14 |
| F5 | 确认 | 模块基线：新增 `server/src/memory-service` 为 M10 root；12 条边按实际判定由 `cycle` 改 `deep-reference`（旧环因删除而解开，条目原文已预言此迁移）；删除 15 条已删源的幻影；新增 2 条 `deep-reference`（`memory-service/context.ts → enterprise/contracts.ts` 只取 `PlatformScope` 类型；`memory-service/source-check.ts → auth/signed-value.ts`，`auth/public.ts` 未导出签验原语） | 702 例外 / 0 违规 / 0 幻影 / 59 环；`module-imports` 14/14 |
| F6 | 确认 | 删除 `deploy/hindsight/test/verify-health.ts`（依赖已删的 `hindsight/health.ts`）；README/ENABLEMENT/backup.sh 的 ops/cleanup/备份登记表述改为 #732 后的真实状态 | 文件级核对 |
| F7 | 确认 | `coverage-plugins-knowledge` 去掉 `/api/memory` 三个入口与整个记忆域映射；`gap-registry` 去掉 `/api/memory` 前缀并改述原因。企业库 5435 未运行，仅静态核对 + `tsc` | `tsc` 0、biome 0 |
| F8 | 确认 | `tests/e2e/api.e2e.test.ts`：`GET /api/memory` 由 401 断言改为显式 404 断言（并保留注释说明 #732） | 未运行（需部署实例），静态核对 |
| F9 | 决策 | 旧 `personal_memories` 数据原样保留、只读；旧行不再有本人自助更正/遗忘/暂停入口。**待用户决定**：是否需要为旧数据提供导出/清理路径 | 本条 + §7 |
| F10 | 确认 | `createMemoryClient` 装配加 `timeoutMs: 5_000`；装载器把超时按 `memory_service_unavailable` 降级，不阻塞回合 | `context.ts` catch 分支 |
| F11 | 决策 | 删除已死的 `config.memoryDefaults` 与 `OPENBOT_MEMORY_SOURCE_DEFAULTS`/`OPENBOT_PROACTIVE_DEFAULTS` 读取（原消费者 `memory/defaults.ts` 已删）。**行为变化**：新 Bot 不再自动获得后台调研/记忆来源默认。是否由记忆服务或 proactive 重新引入默认，待用户决定（#733） | `config.test.ts` 173/173 |
| F12 | 确认 | copilot `required` 臂加注（旧记忆工具已注销，现恒 false，#733 决定是否重设）；`/api/memory-service/source-check` 的挂载点在 `http.ts` 注明仍不挂载（需真实 MEMORY 实例对齐服务令牌） | 静态核对 |
| F13 | 确认 | 陈旧注释清理：`config.ts`、`assembly/http.ts`、`schema/{memory,defaults,proactive}.ts`、`untrusted-content.ts`、`mastra/instructions.ts`、`admin/settings-store.ts`、`assembly/runtime.ts`（旧写面/路由/扫掠描述） | biome 0 |

附带修复（非 reviewer 条目）：`module-runtime-lifecycle` 的真实启动冒烟长期红——测试里的 `KEY_ENCRYPTION_KEY` 字面量解码为 24 字节，`loadConfig` 在 agent-runtime 门前就拒绝；随后 Branch B 等待一个已退出的子进程而挂到 120s。另有宿主 `.env` 的 `SERVER_PORT` 泄漏导致 PORT 冲突。改为合法 32 字节 key、中性化 `SERVER_PORT`、子进程早退时立刻带输出失败。该文件不在 `e2e-bun-suites.json` 清单内，属仓库既有红，非 #732 回归。现 11/11。

复验轮另外发现并修复：`server/tests/bot-lifecycle.integration.test.ts`（在 `server/tests part 3` 清单内）仍按旧行为断言——reset 计划/执行期望 `memories/memorySources/formedMemories` 为 1、并期望 reset 写 `default_opt_outs`。按 #732 语义改为：记忆行保留（计划计 0、执行不删，含 Bot 自形成的行与禁用来源行），reset 不再写默认退出行；`formedMemories` 断言 0。现整文件 11/11，`bot-lifecycle-{audit,routes,watcher}` 23/23、9/9、3/3。

修复后复验（2026-10-31 本机）：`config.test` 173/173、`audit.test` 8/8、`proactive.test` 7/7、`tool-access-public` 28/28、`module-runtime-lifecycle` 11/11、`module-imports` 14/14、`e2e-manifest-contract` 10/10、`bot-summaries` 7/7、`legacy-agent-routes` 5/5、`web-copilot-scope` 14/14；driven：`package-entrypoints`、`memory-service-no-legacy`、`mastra-memory-service-degradation`、`bot-memory`、`bot-settings-rows`、`memory-answer-basis`、`web-memory-routines` 全部通过；`bun run typecheck` 全绿；改动文件 biome 0 error。

### 8c. 用户裁决落地（2026-10-31，同日实施）

- **裁决①（旧数据无路径）**：不新增任何入口；reset/遗忘/更正对旧行均为"不存在该能力"。`memory-service-no-legacy` 与 `bot-lifecycle.integration` 已钉住"行原样保留"。
- **裁决②（默认开启，research-only）**：
  - 新 `server/src/proactive/defaults.ts`：`createResearchDefaults`（单人独聊采用、240 分钟间隔、首跑一个间隔后、try-lock + opt-out + `onConflictDoNothing`）、`lockResearchDefaults`、`recordOptOut`；`proactive/public.ts` 为 AUTOMATION 出口（M03 重置经它读锁与退出，环例外已登记 #732）。
  - `config.proactiveDefaults.research`（`OPENBOT_PROACTIVE_DEFAULTS`，on unless "false"/"0"）；`OPENBOT_MEMORY_SOURCE_DEFAULTS` 不再存在。
  - `proactive/store.remove` 恢复：锁 + 写 `default_opt_outs(proactive_research)`；`lifecycle-reset` 恢复：事务内先锁，删除"本人已关闭"的研究设置前写退出，记忆行仍不删。
  - `assembly/runtime.ts`：恢复 `channelStore.recordActivity` 的 `personSpoke` 钩子并装配 `createResearchDefaults`（`canDeliver` 复用 `deliveryScopeFor`）。
  - 新套件 `server/tests/proactive-defaults.integration.test.ts`（6 用例：采用一次/关掉不再开/删除记退出/锁互斥/投递与部署双门/群聊不采用），清单独立成组 `server/tests/proactive-defaults`；`bot-lifecycle.integration` 第三用例改为"reset 保留本人对研究的 no，记忆源不动"；`config.test` 增 `proactiveDefaults` 组（174/174）。
- **裁决③（授权）**：本节落地后进行提交/推送/PR/#732 票面更新；#733 四站环境另行启动。

### 8d. 复审（2026-10-31，workflow 32 agents：4 维度找 → 双怀疑者对抗验证）

确认 7 条（2 major / 5 minor），处置：
- **[major] mod25 簿记钉套件红**（`mod25-closure-seam.test.ts:152` 钉 715 → 实际 703）：改钉 703 并注明差额来源；现 15/15。
- **[major] `hindsight/config.ts` 生产孤儿 + deploy 文档宣称仍在跑隐私校验**：删除该模块与 `hindsight-config.test.ts`（含清单 entry）；README/backup.sh/hindsight.env.example 的隐私校验表述改为"OpenBot 侧已随 #732 退出，HINDSIGHT_PRIVACY_* 只服务实例自身"。
- **[minor] `schema/defaults.ts` 头注释称退出不再写**：改写为"proactive_research 行恢复写入（proactive/defaults.recordOptOut），memory_source 行为历史"。
- **[minor] `config.ts` 孤儿墓碑注释与恢复的默认矛盾**：删除该注释块。
- **[minor] runtime 陈旧注释与 personSpoke 矛盾**：改写为"会话现在翻开的正是后台研究（上钩子），记忆源采用与写路径已退出"。
- **[minor] 生产 personSpoke 钩子无测试**：`module-runtime-lifecycle` 新增源码钉（wrapper 行/装配门/绑定顺序），12/12。
- **[minor] `degraded-recall.ts` 死代码 + ledger 保留理由不实**：ledger §8 保留清单改为如实（零生产 import），删除与测试改写记 §7 债①。
notes 落地：store.remove 注释改为与实现对齐（先读后锁，agentId 不可变）；copilot `required` 名单加"#733 新工具必须同步"注；`bot-settings-rows` 删除 `/api/memory/sources` 假 mock 分支；`proactive-defaults` 补两用例（`research=false` 时 personSpoke 不建行；退出只绑本 Bot、secondBot 照常采用）。
被驳回但已知悉：`/api/memory` 404 仅活体 e2e 钉住（无部署实例不可跑）；`outage_no_legacy`/`all_surfaces` 属 #733 执行器（§8 已记）；`/api/memory-service` 前缀分类吞并（实际分类面无消费差异）。

### #733 判定：blocked
`report_completeness` 要求 A01–A19 共 19 项真实组件执行并留证据，`version_manifest` 要求记录版本一致。当前缺隔离的 4 站（IDENTITY/MEMORY/OpenBot/外部应用）+ 浏览器 + 网关/Hindsight 运行环境，且 #733 原生 blocked_by 含 #732（#732 自身尚待独立审核）。未创建验收执行器，不声明任何 A 项通过。

## 5. 剩余执行序

727 → 728 → 715 → 730 → 729 → 731 → 732 → 733（每票同流程）；最终：完整范围 OCR 一次 + 总结报告（每票实现/验证/审核状态、用例数、依赖与合同变化、验收证据、待用户决定事项）。