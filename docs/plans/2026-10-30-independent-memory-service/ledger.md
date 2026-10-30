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
| #731 | OpenBot 内嵌记忆管理（承载页/顶层登录回跳/退出） | MEMORY ecdcc6f+feb8455 + OpenBot da8a46b0c+feba5c45a | app/tests/memory-service-frame.test.tsx（5）+ server/tests/memory-service-entry.test.ts（3）+ MEMORY tests/embed-channel.test.ts（3）；浏览器套件 5 用例已收集未执行 | 审核 9 confirmed（去重 6 类）→ 修复轮，六条变异全杀；浏览器验收 blocked（BA 栈未运行） |
| #732–#733 | 待实施 / blocked（依赖 #731 浏览器验收与真实企业集成） | — | — | — |

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

## 7. 债与已知边界

- `#726 观察范围`：memory_cleanups.scopes 暂无 `observe:` 段，待 #730 真实索引接入后补录。
- 更正路径的 revokeVersion 现已建清理；revoke_intents 重放保持（远端故障不丢撤销）。
- 回调投递超时 5s / 重试周期 60s 为 v1 常量；`processing` 租约任务不强行取消（由完成路径自然落终态）。
- 来源撤销幂等查询命中后可返回旧 cleanupId，即使其后有新 confirmed 版本——新内容需新采集与新审核（票面语义），既有清理不再重复通知。
- 浏览器 e2e 依赖 `app/dist` 最新构建；未 build 会静默跑旧界面（本轮曾踩，已记录）。
- 环境事故（本轮）：42xx 端口泄漏 16 个残留 bun identity 进程（kill）；55470 测试库容器被连带清掉（openbot-test-pg/openbot-postgres-1/agent-computer 同批 Exited 255），已用 `docker run --name openbot-test-db-55470 -p 127.0.0.1:55470:5432 postgres:17-alpine` 重建并补建 `openbot_memory_test`/`openbot_identity_test`；`tests/oidc-provider.test.ts` 原用硬编码容器名 `memory713-pg` 已改为走连接串。
- OpenBot 企业测试库 5435 当前未运行；依赖它的 server 集成套件本轮无法验证（#715 投影 store 因此改用合同夹具）。

## 8. #732 / #733 状态：盘点已完成，切换与验收 blocked

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

**判定：blocked**。票面要求逐入口行为断言（`all_surfaces`/`outage_no_legacy`/`worker_disabled`/`legacy_data_unchanged`/`other_lifecycle`）与"删除旧实现后证明只剩新客户端"。当前缺：
1. 真实记忆服务实例与 `MEMORY_SERVICE_URL` 部署值（本地只有协议级测试夹具）；
2. 企业测试库 5435 未运行 → 记忆消费者涉及的 Access/租户集成无法验证；
3. #731 的浏览器验收本身 blocked（BA 栈未运行），而 #732 原生 blocked_by 含 #731。
按票面"不可验证、依赖缺失均标 blocked，不能以 fixture 通过冒充集成通过"，本轮**不删除**任何旧记忆实现（`server/src/memory/`、`server/src/hindsight/` 原样保留），只交付上表盘点。

### #733 判定：blocked
`report_completeness` 要求 A01–A19 共 19 项真实组件执行并留证据，`version_manifest` 要求记录版本一致。当前缺隔离的 4 站（IDENTITY/MEMORY/OpenBot/外部应用）+ 浏览器 + 网关/Hindsight 运行环境，且 #733 原生 blocked_by 含 #732。未创建验收执行器，不声明任何 A 项通过。

## 5. 剩余执行序

727 → 728 → 715 → 730 → 729 → 731 → 732 → 733（每票同流程）；最终：完整范围 OCR 一次 + 总结报告（每票实现/验证/审核状态、用例数、依赖与合同变化、验收证据、待用户决定事项）。