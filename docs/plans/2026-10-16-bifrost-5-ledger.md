# Bifrost-5 Ledger（可恢复状态）

- Orca Run: `run_f470ca949934`（objective：Bifrost-5 实施 151 Ticket）
- 快照: `.omc/research/bifrost5/tickets.json`（151 票正文/状态/依赖，2026-10-16 摄取）
- DAG/波次/AC 映射: `docs/plans/2026-10-16-bifrost-5-dag.md`
- 计划: `docs/plans/2026-10-16-bifrost-5-implementation.md`
- 集成基线: 主 checkout `/Users/wuyongjun/trea/OpenBot`（main @ bab7c0b9 起，未提交增量累积；各 worker 子 worktree 名 `b5-<ticket>`）

## 票据状态

| 票 | 组 | 状态 | Task ID | Dispatch ID | Worktree | 检查点 | 备注 |
|---|---|---|---|---|---|---|---|
| #207 | 01.1 | **verified+integrated** | task_5749a47a5506 | ctx_ebf5528c37e6 + fix ctx_b5868d026992 | b5-207（已释放） | ckpt ✓ | F1/F2/F4/F6 修复复审全 CLOSE（reviewer 独立复验 [1,2]）；集成含 config.ts 三方合并（import 冲突手工解 + gatewayConfig 双实现合并为单函数统一 GatewayConfig 类型）+ 4 文件直复制；64/64 合并验证全绿；#208 解锁 |
| #209 | 01.3 | **verified+integrated** | task_8047fcd8feb2 | ctx_082fa912af1a | b5-209（已释放） | ckpt ✓ | review 通过（0 中高危/1 low 注释错位）；4 文件集成哈希全过 |
| #215 | 02.1 | **verified+integrated** | task_edf454823ae8 | ctx_6a95c7bcb7c5 | b5-215（已释放） | ckpt ✓ 复审版 | M1/L2 修复后复审通过（21/21×3）；7 文件集成；下游 #216/#217/#218/#290 解锁 |
| #216 | 02.2 | **verified+integrated** | task_063427f47b8a | ctx_18775224f825 | b5-216（已释放） | ckpt ✓ | review 通过（0 中高危/2 low）；3 文件自有增量集成 |
| #218 | 02.4 | **verified+integrated** | taskmap['218'] | ctx_d31166b64382 | b5-218（已释放） | ckpt ✓ | review 通过（0C/0H/0M/2L/3I，签名收敛裁决在授权范围内）；9 文件自有增量集成（config/journal diff 甄别为 209 同步层，跳过）；37/37 集成验证 |
| #211 | 01.5 | **verified+integrated** | task_708a7fabf2fb | ctx_6610743db459 前实现已结算（review ctx_186e85a611cc） | b5-211（待清理） | ckpt ✓ | review 通过（0C/0H/0M/2L/4I）；5 自有增量集成（probe.ts+2 测试+fake-gateway+计划）哈希 5/5；int4 库 migrate 后 169/169 集成域全绿 + 双 typecheck 0（1 次 flaky 重跑消失）；#212 解锁 |
| #234 | 04.1 | **verified+integrated** | task_8142899ca59b | ctx_998ae61aff46 | b5-234（已释放） | ckpt ✓ | review 通过（0 中高危/2 low）；22 直复制 + 迁移重编号 0123 + snapshot 合并（补 public.payer_accounts）+ journal 追加；集成层全量验证 73/73 + 双 typecheck 0；#235 解锁 |
| #235 | 04.2 | **verified+integrated** | taskmap['235'] | ctx_22b0951ca847 | b5-235（已释放） | ckpt ✓ | review 通过（0C/0H/0M/2L/6I）；集成含三方合并（app/audit/config/core/index/types/journal）+ 8 新文件；交互修复：#218 收敛签名后前置票 payer 测试适配版补齐 |
| （其余 144 张） | | pending | 已建 task 行 | | | | 票→task_id 映射：`.omc/research/bifrost5/taskmap.json` |

集成模型：无 commit 授权下，每票验收后 coordinator 将其 worktree 未提交增量显式复制进主 checkout 集成层；下游 worktree 创建后、worker 启动前，coordinator 先把集成层同步进该 worktree（含哈希核对），再 `worker-start --worktree <exact>`。

## 事件日志

- 2026-10-16 T1：Issue #5 + 151 票摄取；DAG 验证通过；Run `run_f470ca949934`；151 task 行建好。Wave 1 派发（全部 pi/ready）。
- T2：**4 速率限流事件**——glm-5.3 账户 429（4 并发超限），#207/#209/#234 agent idle。裁决：并发降至 ≤3，串行唤醒，不重派不丢工。#215 未受影响完成。
- T3：#215 全流程闭环（验证 18/18→审阅 1 medium→修复 M1+L2→复审 21/21×3 通过）→ 集成主 checkout（7 文件哈希全过，typecheck+21/21 复验）→ 释放终端。
- T4：#207 coordinator 验证 33/33 + review（Spec 合规通过、F1 high 实测复现首存竞态）→ fix-207 派发（F1+F2+F4+F6）。#209 验证 22/22 → review 运行中。#234 唤醒。

- T5：#209 review 通过（1 low 注释错位，记录）→ 集成 → 释放。#216 全流程闭环（review 0 中高危）→ 集成 → 释放 → #218 派发（20 文件同步）。
- T6：#234 question 裁决（允许填票据 Checkpoint 段，仅追加）；#234 完成（23/23）→ review 通过（2 low/2 info）→ 集成（0122→0123 重编号、snapshot 合并、journal 链修正）→ 集成层 73/73 全绿 + server/app typecheck 0 → 释放 → #235 派发（44 文件同步）。
- T6a：**事故记录**：集成库 URL 拼接错误（/openbot/openbot_b5_int1 双路径）导致 migrate 连接失败；核查 live openbot 库确认未受影响（无新表、110 基线迁移）。教训：TEST_DATABASE_URL 构造必须用 sed 替换末尾库名。

- T7：fix-207 复审通过（全 CLOSE，reviewer 独立复验并发 [1,2]）→ 集成（config.ts 与 #209 三方合并：import 冲突手解、双 gatewayConfig 合并为单函数、GatewayConfig 扩为 endpoint+conversionRate 统一块、删重复字段声明）→ 64/64 验证 → 释放 4 终端 → #208 派发（48 文件同步）。
- T8：#218 review 通过 → 集成（自有 9 文件；config.ts/_journal diff 甄别为同步层噪声，跳过）→ 37/37 → 释放 → #217 派发（57 文件同步，补上组 02 公司 payer 链）。
- 进度：verified+integrated = #207/#209/#215/#216/#218/#234（6/151）。运行中 = #208/#217/#235。
- T9：#235 集成（app/audit/journal/index/types 三方合并，config.ts 保 207+209 合并版；index.ts 重复 botServiceStore 声明收敛为 235 registry 版）；发现并修复跨票交互：#218 credits 签名收敛（PayerRef）导致主 checkout 旧版 payer 测试挂——用 #218 worktree 内适配版补齐 payer-account/payer-legacy 测试。全量 87/87 DB + 单元 + 双 TC 0。
- T10：#208 完成（29/29，含 coordinator 批准的枚举/迁移 0124/app 接线/审计事件 4 项越界）→ review-208 派发；#236 派发（66 文件同步）。#208 迁移撞号（与 235 同为 0124）→ 集成时重编号 0125。
- 进度：verified+integrated = 7（207/209/215/216/218/234/235）+ 208 verified 待 review。
- T11：#208 集成（含 4 项已批越界落点；枚举合并 gateway_admin+bot_service；journal 链 0122→0125）→ 102/102 全绿 → 释放 → #211 派发（72 文件同步）。#217 完成验证 13/13 → review-217 派发。#236 范围裁决（4 项批准，迁移号集成期统一重排）。
- 进度：verified+integrated = 8（207/208/209/215/216/217 进行中 review/218/234/235）。

- T12：#211 review 通过（双结论 PASS，2L/4I 备案）→ 集成（5 文件直复制哈希 5/5）→ 验证：新建 openbot_b5_int4 + migrate → 集成域 169/169（首轮 1 fail 复跑两轮均 0，判 flaky）+ server/app typecheck 0 → 释放 review 终端 → #212 派发（b5-212 worktree + 83 文件 sync_delta 0 mismatch + pi worker ctx_6610743db459）。#210（blocked_by=209 已满足）排队待并发空位。事故教训补充：bun 1.4 建库用 `new SQL(url)`（bun 模块），migrate 前需先建库再 `DATABASE_URL=... bun scripts/migrate.ts`，专用集成库命名 openbot_b5_int<N> 递增。
- 进度：verified+integrated = 10（即 207/208/209/211/215/216/217/218/234/235 共 10 张）。运行中 = #219/#236/#212。
- T13：**环境事件**：#236/#219/#212 三个 worker 终端全部异常停止（Agent process stop requested but never confirmed，疑似 Orca/宿主重启；与 memory 中子代理故障模式一致）。按 goal 指令 8 失联只算检查点不算失败：三个 worktree 死前进度盘点完成（#236：binding-codes/bot-binding/0125 迁移/测试等 13+ 文件；#219：payer-binding/payer-no-fallback 测试/copilot+index 5 文件；#212：计划+fake-gateway）。task 均回 ready，串行重新 worker-start 至原 worktree：#236→ctx_c8970a05cd53、#219→ctx_075ed2bbb7cb、#212→ctx_1af8aaf4953a，恢复简报已发（含各自死前进度清单与续做指引）。
- T14：#236 接续 worker 完成（ctx_c8970a05cd53）：10/10 本票 + 62/62 回归 + 双 TC 0 + lint 0，修复前序 4 缺口 + 1 生产缺陷（hint 超长静默截断→400），app.ts 挂载 POST /api/bot-service/binding-codes 于 04.2 服务守卫下；3 项基线遗留失败（0107/0073/0120 漂移、04.2 枚举致 schema.test 过期）按名记录于 .omc/reports/b5-236.md。coordinator 重跑验证：新库 openbot_b5_236v migrate 后 39/39 + 双 TC 0 + checkpoint 71 文件哈希 0 mismatch → 释放终端 → review-236 派发（task_f351b9aa64cc / ctx_1571577d5e80，主 checkout 只读）。
- T15：#212 接续 worker 完成（ctx_1af8aaf4953a）：capability-negotiation.ts（negotiateGatewayCapabilities/readLastGatewayNegotiation、AC04 configVersion 失效、X.Y.Z major=1、enterprise_settings 无新迁移）+ 25 单测 + 8 集成；顺带修复中断残留（fake-gateway 损坏注释块 + 失效导入重复测试文件），已甄别 #211 集成产物 3 文件哈希不变。coordinator 重跑：新库 openbot_b5_212v migrate 后 119/119（含 01.5 probe 回归）+ 双 TC 0 + checkpoint 85 哈希 0 mismatch → 释放 → review-212 派发（task_eb29d7f3eee7 / ctx_a58871553a0e）。
- T16：**基础设施事件**：宿主 PostgreSQL（openbot-postgres-1，OrbStack）进入崩溃-恢复循环（WAL redo 127s 完成后又 reinit）；同机另一 Run（opik）多 worker 并发 tsc 导致 CPU 过载（多任务假死）。应对：起独立验证容器 b5-verify-pg（pgvector/pgvector:pg16 @ 127.0.0.1:5590，openbot/openbot），后续所有 DB 验证迁至该实例，专用库名不变。
- T17：#236 集成完成：迁移 0125_bot_binding_offers→0126 重编号 + snapshot 合并（共同 prevId 0124，仅多 bot_binding_offers 表，干净合并）+ journal 追加（修 when 严格递增）。app.ts/audit.ts 因 merge-base 错序丢失 #208 gatewayAdminCredential 装配/事件 → 以 worker 版为底补回（import+装配块+2 审计事件）；registry/auth 直接采用 worker 版（binding-codes 组合）；schema/index + drizzle.config 加法冲突取 theirs。主 checkout tests/support/ 下两个坏副本 gateway-probe*.test.ts（中断 worker 残留，review-212 警告）已删除。验证：int5（临时实例）migrate + 全量 212/212 + 双 TC 0。#237/#220 解锁。
- T18：review-212 通过（双 PASS，2L/3I；限制：集成测试因 DB recovery 由 coordinator 集成后复验补齐 ✓、全量 tsc 因过载以范围化 0 替代 → 集成后已补 ✓）→ #212 集成（4 文件哈希 4/4 + 坏副本删除）→ 129/129 域内 + 212/212 全量。释放 review 终端。
- T19：#219 闭环推进：coordinator 重跑（219v 库 @5590：payer+credits 域 100/100 + 双 TC 0 + checkpoint 80 哈希 0 mismatch）→ 释放终端 → review-219 派发（task_42bedc98ced9 / ctx_6a4a1de7569b，简报含 5590 专用实例指引）。#237 派发（b5-237 + 89 文件 sync + ctx_921db44b7b72，含 review-236 下游提醒：多条 pending 消费语义归 04.4）；#220 派发（b5-220 + 89 文件 sync + ctx_2c8c7a503882）。
- 进度：verified+integrated = 12（207/208/209/211/212/215/216/217/218/234/235/236）。运行中 = review-219 / #237 / #220。待解锁：#238（差 #220）。
- T20：review-219 结论：Spec 合规通过 / 质量 B+（1 Medium F1 + 4 Low）。F1 有效（变异注入 gate 二次 reserve 后 23 用例仍绿，清单测试对 billing.externalCustomerKey 失明）→ 回派修复（fix-219 task_a49e9482d0de）。#237/#220 完成派发后运行中。
- T21：**第二次 Orca 重启**：fix-219/#237/#220 三个 worker 终端全部死亡（重启前均未完成；fix-219 heartbeat 至 investigating）。处置：worker-abandon 结清三 dispatch → task-update 回 ready → 同 worktree 重派（fix-219→ctx_51424e36abe0、#237→ctx_f31d7d145f32、#220→ctx_a15e5df746d9）+ 恢复简报（含各自死前进度清单）。worktree 死前进度盘点：#237 已有 hardening 计划+binding-codes 修改+集成测试；#220 已有 credits/routes/types 修改+personal-credits-read.test.ts。b5-verify-pg（5590）未受重启影响存活。
- T22：hiroute 上游 502（no upstream candidate）风暴：三个 worker 全部重试 3 次耗尽停摆；#220 的 dispatch 直接 failed。处置：#237/fix-219 send 唤醒成功；#220 abandon→ready→重派（ctx_59a99956a220）+ 接续简报。
- T23：#220 接续 worker 完成（ctx_59a99956a220）：三条个人读路由 + Credits.personalBalance + 契约，10/10（103 断言）+ 86 回归 + 双 TC 0 + lint 0，Proxy 计数零写入有数据库证明。coordinator 重跑：220v 库 @5590 域内 73/73 + 双 TC 0 + checkpoint 93 哈希 0 mismatch → 释放 → review-220 派发（task_478f5b760186 / ctx_cb631d8c4112）。
- T24：**第三次环境事件**：fix-219/#237 终端再次消失（terminal_missing，唤醒后无新进展）。task 自动回 ready → 重派（fix-219→ctx_4285ad7bfb5e、#237→ctx_e852d65483a3）+ 再接续简报。review-220 未受影响。
- T25：review-220 通过（Spec 合规 PASS / 质量 A-，F1 Medium=集成窗口风险非本票缺陷 + 2L/2Nit，reviewer 建议可集成）→ #220 集成：6 自有增量直复制哈希 6/6；F1 裁决=集成时同步防御（usage.tsx 7 处 optional chaining：plan 1 + rewards 6，消除过渡期 UI 崩溃）；F2=02.6 票 Checkpoint 已回填（含 manifest/验证/报告指针）。
- T26：集成回归发现 **#211/#212 测试时间炸弹**（2 fail 稳定复现）：'older completion never overwrites newer' 夹具用固定 12:00Z，前序测试残留真实时钟行使 setWhere 正确拒绝夹具写入（本机时间越过 12:00Z 后必红；生产 store 逻辑经最小脚本复现证明正确）。修复=夹具改 Date.now()±1h 动态时间戳（negotiation+probe 两文件），3 轮 17/17 稳定。修复记录：`server/tests/gateway-capability-negotiation.integration.test.ts`、`server/tests/gateway-probe.integration.test.ts`（测试基建修复，非生产代码）。
- T27：#220 集成验证：int6 @5590 全量 211/211（21 文件）+ 双 TC 0。**#238 解锁**（220+236 均已集成）。
- T28：#238 完成（ctx_b985edbf06e3）：access_grants 表（0127 手工组装沿 0126 链）+ 两步确认流 + 前端确认页/i18n/侧边栏 + 审计 model_access.*；13/13×5 连跑 + 邻居回归 + 双 TC 0 + lint 0 + vite build。coordinator 重跑：238v 库 @5590 72/72（含邻居）+ 双 TC 0 + checkpoint 105 哈希 0 mismatch → 释放 → review-238 派发（task_a4c5ac1984ec / ctx_5d9e51107da2）。运行中 = fix-219 / #237 / review-238。
- T29：review-238 双 PASS（0C/0H/0M/3L/4I，建议 04.7 顺带打磨）→ #238 集成（20 文件 + lib/model-access 目录直复制哈希全过；同步层=T27 时点无并发冲突；CONTEXT.md 领域文档随票更新）→ int7 @5590 migrate 至 0127 + 全量 285/285（25 文件）+ 双 TC 0。组 04 链 04.1→04.5 全部落地。
- T30：#239 完成（ctx_922d9097c479）：AccessGrantUseError + resolveForBot/resolveForUser 统一不可区分拒绝 seam（04.7/05.x 消费入口）+ 13 测试 157 断言（四类 AC + 无泄露扫描 + 入口清单探测）；HTTP 入口核查组 04 无请求体取身份（strictObject），无路由变更。coordinator 重跑：239v 库 68/68 + 双 TC 0 + checkpoint 112 哈希 0 mismatch → 释放 → review-239 派发（task_88986af9e6d4 / ctx_f987407597b9）。#239 派发记录（T29 补）：b5-239 worktree + 110 文件 sync + task_470beba5e2de。
- T31：review-239 双 PASS（0 阻断/0 重要，delta 隔离与 write scope 双向核验）→ #239 集成（3 文件哈希 3/3）→ int8 验证 113/113 + server TC 0 → #240 派发（b5-240 + 115 文件 sync + ctx_5e45a6a01c70，含 review-238 三 Low 打磨建议）。运行中 = fix-219 / #237 / #240。
- T32：**第二次 hiroute 502 风暴**：fix-219/#237 再次重试耗尽停摆（liveness unverifiable）→ send 唤醒两 worker。
- T33：#240 完成（ctx_5e45a6a01c70）：GET /grants + revoke 路由（事务条件更新/幂等/统一 404/恰一审计/不碰台账）+ 前端我的授权区块 + 8 server + 4 UI 测试；87 回归 + 双 TC 0。coordinator 重跑：240v 库 66/66 + 双 TC 0 + checkpoint 119 哈希 0 mismatch → 释放 → review-240 派发（task_f8b3172341fe / ctx_a12fb113d213，含 3 Low 打磨兑现核验项）。运行中 = fix-219 / #237 / review-240。
- T34：review-240 双 PASS（Spec 4/4 AC 含 8 路并发撤销探针；质量 A-；**3 Low 打磨 0/3 兑现**——派发指令偏差，Low 级不阻塞，记录为遗留可在 06.x/OCR 阶段处理）→ #240 集成（12 文件哈希 12/12）→ int9 全量 306/306（27 文件）+ 双 TC 0。**组 04（Bot 服务接入链 04.1–04.7）全部集成完毕**。
- T35：就绪队列计算（依赖⊆已集成集）：#210/#221/#241/#290/#345 共 5 张。派发 #210（b5-210 + 119 sync + ctx_651b16c858e8；01.4 完成后 #213 门禁解锁）。运行中 = fix-219 / #237 / #210。
- T36：**第三次 hiroute 502**：fix-219/#237 再次停摆 → 第三次 send 唤醒。#210 正常推进（worktree 持续更新）。
- T37：#210 完成（ctx_651b16c858e8）：gateway_rate_versions 不可变追加表（0128 触发器先例 0012）+ rateVersionAt/readRateVersion 契约 + save() 同事务并发序列化；30/30 + 152 网关系列。coordinator 重跑发现 **worktree 环境缺口**：app/src/lib/generated/application-config.ts（构建产物，sync_delta 不携带）致 app tsc 4 错——复制生成文件后 tsc 0；教训：worker app 验证前若报 TS2307 generated 模块先补该文件。重跑：210v 库 96/96（网关域）+ 双 TC 0 + checkpoint 125 哈希 0 mismatch → 释放 → review-210 派发（task_940d73d0f604 / ctx_d9d3f0d2c507）。运行中 = fix-219 / #237 / review-210。
- T38：review-210 双 PASS（0 阻塞/5 INFO；触发器三连拒绝实测、并发版本号不重复）→ #210 集成（11 文件哈希 11/11，迁移链至 0128）→ int10 全量 338/339（1 fail 复跑两轮不可复现判 flaky）+ 双 TC 0。**#213（01.7 消费入口就绪门禁）解锁**。
- T39：#213 派发（b5-213 + 125 sync 含生成文件补齐 + ctx_77a82533def1）。运行中 = fix-219 / #237 / #213。
- T40：#213 完成（ctx_77a82533def1）：readiness.ts 单一就绪门禁（五条件 fail-closed + 14 reasonCode + 从不拨网从不回退）+ app.ts 装配；单元 20 + 集成 14。coordinator 重跑：213v 库 110/110（网关+readiness 域）+ 双 TC 0 + checkpoint 129 哈希 0 mismatch → 释放 → review-213 派发（task_3c1feaebdd18 / ctx_4c16844fd878）。运行中 = fix-219 / #237 / review-213。
- T41：review-213 双 PASS（0H/0M/1L/4I）→ #213 集成（5 文件哈希 5/5；app.ts 装配核验 #208/#236/#238 装配完好）→ int11 全量 373/373（32 文件）+ 双 TC 0。**组 01（网关就绪 01.1–01.7）全部集成完毕**。
- T42：就绪队列 7 张（214/221/223/241/242/290/345）。派发 #214（b5-214 + 129 sync + ctx_ab291e8b64ea）。运行中 = fix-219 / #237 / #214。
- T43：#214 完成（ctx_ab291e8b64ea）：/api/admin/gateway 管理面（status 诊断+保存+probe 动作+链式协商）+ 管理员网关设置页（凭据指纹不明文）；server 9/9 + app 4/4。coordinator 重跑：214v 库 69/69 + 双 TC 0 + checkpoint 136 哈希 0 mismatch → 释放 → review-214 派发（task_d55ca7d2dfc2 / ctx_9f5dd6060e1c）。运行中 = fix-219 / #237 / review-214。
- T44：review-214 双 PASS（0H/1M/3L；F1 Medium=sidebar↔admin index 布局一致性跨 #234+#214 的整合问题，reviewer 建议另开小票不阻塞——**记录为遗留项 F1-214**；3 动作路由字面越界系 AC1 必需已留痕裁定）→ #214 集成（12 文件 + lib/gateway 目录哈希全过）→ int12 全量 382/382（33 文件）+ 双 TC 0。
- T45：fix-219/#237 经 3 次 send 唤醒无效（终端死锁在 502 重试耗尽，worktree 自 10-16 午后停滞）→ abandon → task ready → **全新 worker 重派**（fix-219→ctx_9ed85787191d、#237→ctx_bd059656a2fa）+ 第 4 次接续简报（#237 额外提示同步层过旧、不要参考主 checkout）。3 并发 = fix-219 / #237 / （空位备用）。
- T46：#237 第 4 次接续完成（ctx_bd059656a2fa；前次中断已写完全部代码，本次完成验证）：createBindingOfferConsumer + 双统一错误类 + 7 集成测试（并发双花 7/7×3 轮）；双 TC 0 + biome 0。coordinator 重跑：237v 库 29/29 + 双 TC 0 + checkpoint 91 哈希 0 mismatch → 释放 → review-237 派发（task_f57320c20c20ec6 → ctx_0bef5fd9e469，含 review-236 Low1/Info4 落实核验项，注明旧同步层只审自有增量）。运行中 = fix-219 / review-237。
- T47：fix-219 F1 修复完成（ctx_9ed85787191d）：双层修复全在测试侧（行为层提取 gate 闭包真执行 + 结构层标识符断言），M6a/M6b 双变异 RED 证实，28/28 + TC 0，生产代码零改动。coordinator 重跑 219f2 库 28/28 → checkpoint 复抓 → rereview-219 派发（task_b80f48646909 / ctx_915afb713825，要求亲手复现变异）。
- T48：review-237 双 PASS（0 硬违规/2 低 smell）→ #237 集成（3 文件哈希 3/3；binding-codes.ts 集成层版本=其同步层版本，diff 纯为消费半边增量）→ 集成层 63/63（bot-services 域）。**组 04 全部含 04.4 落地**。运行中 = rereview-219。
- T49：rereview-219 F1 CLOSE（生产代码零改动证实 + 双变异复现成立）→ #219 集成：payer-binding.ts + 修复版 payer-no-fallback.test.ts + 计划直复制；index.ts/copilot.ts 以 diff-patch 方式应用（纯加法 + externalCustomerId→payerBinding 收敛 + CreditGateError→CreditInsufficientError 语义化），#236 装配完好（registry 三处）。集成层 205/205（20 文件）+ 双 TC 0。**verified+integrated = 21/151**。
- T50：批量派发 #221/#223/#241（各 142 文件 sync + 生成文件 + 简报；ctx_bf76ea6e7df1 / ctx_9cbb62f0a856 / ctx_5e5947686d3b）。就绪队列剩 #242/#290/#345 待空位。

## T51 — #223（03.1 目录抓取与 ModelRef 规范化）闭环前半段（2026-10-17）

- worker（b5-223 worktree）完成：catalog.ts（fetchCatalog/listModelRefs、ModelRef 三元组规范化、能力仅从 supported_methods 推导、不可判定记 unknown+原因）、gateway_model_catalog_refs（三元组唯一索引）+ gateway_catalog_fetches（append-only）两表、0129 迁移+snapshot、catalog-fetch.integration.test.ts + catalog-model-ref.test.ts
- coordinator 验证：checkpoint 抓取（148 files，HEAD bab7c0b9）；专用库 openbot_b5_223v @5590 roles+migrate 成功；域测试 59/59 pass（catalog-fetch + catalog-model-ref + readiness-gate + rate-version + negotiation 回归）；双 typecheck 0
- checkpoint 哈希核对：148/148 一致
- worker-release ctx_9cbb62f0a856 完成
- review-223 派发：task_62bf570cb8aa → dispatch ctx_dbeedcbb61fb（主 checkout 只读），简报 /tmp/b5-223-review.txt（要求独立建库 openbot_b5_223r 重跑域测试、迁移链核验、ModelRef unknown 语义与泄漏纪律 AC 核验）
- 待审阅通过后集成（0129 迁移链接入主 checkout）

## T52 — #223 集成完成 + 域回归基线扩大（2026-10-17）

- review-223 双 PASS（Spec 4/4 AC；质量 9 findings 全 low/info）→ #223 集成：8 文件直复制（catalog.ts、schema/gateway.ts +2 表、0129 迁移链、2 测试、计划）；迁移链现至 0129。
- **验证事故与裁决**：集成回归本打算跑域全集，误跑裸 `bun test`（565 文件全套）污染 int13 且暴露大量非域环境失败（旧迁移 meta 测试 0087–0120、Intelligence 403 等）——教训：**永远显式列测试文件**；且 5590 容器被 #290 worker 打满（257% CPU/66 连接）导致 hook 超时——起第二容器 **b5-verify-pg2 @5594** 供 coordinator 独占。
- **域回归基线扩大**：从 int12 的 33 文件扩到 53 文件（补 billing-reconcile/usage-delivery/sync/statements/store/capacity/entitlement/webhook 等）。int14b @5594 结果 **816/818**：catalog 域 59/59 全绿；2 个失败（billing-reconcile 'exact credit-identity beyond MAX_SAFE_INTEGER' 240s hook 超时、'plan_grant_missing' 10s hook 超时）**经 A/B 判定与 #223 无关**：/tmp/pre223（HEAD+集成层-#223，journal 截到 0128，schema/gateway.ts 取 b5-221 同步版）同库同命令同样失败。**记录为集成层既有问题 KNOWN-ISSUE-BILLING-RECONCILE**（这两个测试从未进过 Bifrost-5 验证范围，#290 10.1 订单票可能踩到，届时处理）。
- 双 typecheck 0；reviewer 终端已释放；task completed；**#224（03.2 价格快照）解锁**。

## T53 — #241/#290/#345 coordinator 验证完成，三 review 并行（2026-10-17）

- worker_done 三连：#241（04.8 隐式授权）、#290（10.1 订单归属，292/292 worker 域）、#345（21.1 清单枚举）。checkpoint 各抓取（145/162/145 files），哈希核对 452/452 一致，终端已释放。
- coordinator 复验（专用库 @5594 隔离容器 b5-verify-pg2）：#241 域 95/95 + 双 TC 0；#290 域 197/197（含 billing-reconcile 28/28）+ 双 TC 0；#345 域 23/23 + 双 TC 0。
- **KNOWN-ISSUE-BILLING-RECONCILE 修订（推翻 T52 的部分结论）**：billing-reconcile 两超时在主 checkout 上单独跑 28/28、与 billing-credits 二元组 38/38、含 negotiation 三元组 63/63 全绿（均全新库）；#290 worktree 197/197 亦绿。结论：**非 #223/#290 回归，非稳定代码缺陷**——是 53 文件大组合运行时的跨文件 DB 状态干扰（疑似某文件残留行使 reconcile 的等待 hook 永不满足），T52 的 /tmp/pre223 A/B 失败属重建树伪影（符号链接 node_modules 改变模块解析）。教训：A/B 优先在真实 checkout+全新库复跑，重建树只作最后手段。终局全量验证将按批分组运行规避。
- **迁移号冲突预警**：#241 与 #290 各自造了 0129（access_grant_source / payment_order_owner），与已集成 #223 的 0129_gateway_model_catalog 冲突——集成时 #241 重编号 0130、#290 重编号 0131，snapshot prevId 重链。#345 无新迁移。
- review-241/290/345 并行派发（ctx_2807e897e1e7 / ctx_8578310ba2a3 / ctx_eeac4179c9a7，主 checkout 只读，简报含 5594 独立库要求与 #345 零破坏性静态审查要求）。#221、#224 worker 继续运行。

## T54 — #290 集成完成（0130）；fix-241 与 review-345 运行中（2026-10-17）

- review-290 双 PASS（AC 4/4，质量 A-：2 LOW + 2 INFO）→ 无回派。集成：0129→**0130** 重编号（按集成顺序，快照 prevId 重链 #223 0129 id 60d5c87f）+ journal 131 链 + 19 文件直复制。库内实证 owner_payer_kind/owner_payer_id + owner_pair_check + owner_kind_check。
- int15 @5594：域 248/250，唯二失败=payer-legacy-mapping 跨文件计数（=review LOW-A 披露的 02.2 测试隔离弱点；**全新库 iso4 solo 7/7 绿**证实非集成缺陷；int15 solo 5/7 系残留行所致，与 LOW-A 同根）。双 TC 0。**#291（10.2 回调按订单归属到账）解锁**。
- 操作事故与恢复：回填票面时 mv 覆盖 10.1 原文——该票 tracked 无未提交修改，git checkout 恢复后重追加，损失为零。教训：追加类操作先核对目标文件名存在与否。
- review-241 F1（MEDIUM：ensure 审计失败后重试不自愈）→ fix-241 回派（ctx_c38c722d8b08 @ b5-241，TDD 要求 RED 先行）。review-345 进行中（终端见 21.2 书面确认）。

## T55 — #345 集成完成（2026-10-17）

- review-345 双 PASS + 零破坏性独立证实（全 SELECT / READ ONLY 事务局部 / fixture 零残留）→ 无回派。reviewer 唯一缺口：报告未落盘（终端结论完整，coordinator 捕获存档 b5-345.md，dispatch completed）。
- journal 甄别为纯基线（129 项止于 0128）→ 自有增量仅 3 文件，直复制。int16 @5594：5/5 + server tsc 0。**#346（21.2 书面确认/清理计划）解锁**（承接 review 备注①②）。
- 迁移链现 131（…0129_gateway_model_catalog, 0130_payment_order_owner）。

## T56 — #221 集成完成：组 02 全落地（2026-10-17）

- review-221 双 PASS（4 low/info）→ 集成 9 文件直复制（routes.ts/journal/gateway.ts 甄别为漂移非自有）；usage.tsx 以快照契约对齐版覆盖 #220 防御链（承接 F1-220 裁决，正式消除该遗留形态）。验证：app TC 0 + UI 24/24。**组 02（02.1–02.7：payer 账户/映射/解析 + 个人积分 API + 余额页面）全部集成完毕**。
- fix-241 验证 45/45（全新库 fix241r @5594；原 241v 库被 fix worker 清理所致 3D000 误报已排除）；checkpoint 241fix 已抓；rereview-241 派发（ctx_ad8e99818e9d）。
- 运行中：#224（03.2，报 jsonb 基线发现待其完成后验证）、rereview-241。已闭环本段：#223/#290/#345/#221 四张集成 + fix-241 待复审。

## T57 — fix-241 复审 CLOSED → #241 集成完成：组 04 全落地（2026-10-17）

- rereview-241（ctx_964820dec823，首次撞 502 风暴 abandon 重派）：F1 **CLOSED**（方案一镜像 confirm 双路径审计完整采纳、注释矛盾消除、2 新测试钉死自愈+one-per-ask、快照零漂移、独立库 45/45）。
- #241 集成：0129→**0131**（prevId 重链 0130 id 42263baa）+ 5 文件直复制。int17 @5594：域 104/104 + 双 TC 0；source 列/默认值库内实证。迁移链现 132（…0129 catalog, 0130 order_owner, 0131 access_grant_source）。
- **组 04（04.1–04.8）全部集成完毕**。累计闭环：组 01、02、04 全组 + 03.1 + 10.1 + 21.1 = 26 张。
- 运行中：仅 #224（03.2，jsonb 基线发现待验证）。

## T58 — 基线级发现：Bun SQL jsonb 编码缺陷（2026-10-17）

- 来源：#224 worker 上报 + coordinator 独立证实：**drizzle 在 Bun SQL 下的 jsonb 参数以 string 标量入库**（`SELECT jsonb_typeof(raw_entry) FROM gateway_model_catalog_refs` → `string`，int14b 实测 2 行）。读取端单次 JSON.parse 后语义不变，故被掩盖；但库层数据形状错误（jsonb 列存标量），SQL 级 jsonb 操作符（->>/@>）不可直接用。
- 影响面：基线所有 drizzle jsonb 插入（enterprise_settings.value、#223 raw_entry、以及其他 jsonb 列）。#224 在本票内以对象参数绕开并以 CHECK 阻断。
- 处置：**超出 #207–#357 票面授权范围**——记 Ledger 备案，待用户裁定是否开基线修复 issue（候选修法：drizzle customType 或驱动层参数编码统一为对象/JSON.stringify 去双引号）。

## T59 — #242/#224 验证完成；第二波派发（2026-10-17）

- #242（05.1）：checkpoint 147 files；coordinator 复验 171/171（customer-provisioning + billing/payer 域）+ 双 TC 0；review-242 派发（ctx_31135fae976f）。worker 披露基线 1 个失败测试 qa-batch1-migration-0071 系 HEAD 缺迁移文件的既有问题（与本票无关）。
- #224（03.2）：checkpoint 155 files；coordinator 复验 88/88（37 新 + catalog/readiness/rate 回归）+ 双 TC 0；jsonb 绕开方案（对象参数 + CHECK 阻断）待 review 专项核验。review-224 派发（ctx_4d5e25917b09）。迁移号 0130→集成时重编号 0132。
- 纪律：#224/#242 在 5432 实例建专用库（未触 live 库但违反指令）——新简报已重申"禁止 5432 实例（包括专用库）"。
- 第二波派发：#291（10.2，ctx_26db385109c1）、#346（21.2，ctx_0cae5160f044）、#243（05.2，ctx_ab1cf61276e3）；worktree 185 文件同步 0 mismatch（集成层已含组 02/04 全量+0130/0131 链）。

## T60 — #242 集成完成；fix-224 派发（2026-10-17）

- review-242 双 PASS（无阻塞，4 非阻塞备注）→ 集成：0129→**0132**（prevId 重链 0131，journal 133 链）；gateway.ts 以 diff-patch 合并（customers 表块干净应用；imports hunk 因 #223 jsonb 已演化被拒→手补 type import）；漂移甄别跳过 access-grants/locales/usage（#241/#221 已集成的较新版本）。int18 @5594：69/69 + server tsc 0。
- review-224：Spec PASS / 质量 PASS + **F1 MEDIUM**（WIRE_SOURCES.reasoning wire key \"n\" 系错误事实，上游实为 internal_reasoning；当前 latent 无资金风险但 fixture 钉死错误契约）→ fix-224 回派（ctx_a3d9744b9604 @ b5-224，RED→GREEN）。jsonb 基线缺陷 reviewer 亦独立复证（同 int14b 结论），维持 T58 备案待用户裁定。
- 运行中：fix-224、#291、#346、#243。

## T61 — fix-224 验证 + #346 验证；rereview/review 派发（2026-10-17）

- fix-224：WIRE_SOURCES.reasoning→internal_reasoning + fixture/注释/计划三处齐修。coordinator 复验：全新库 5594 上 ./tests/price-snapshot.{test,integration}.test.ts + catalog 回归 **47/47** + tsc 0。**坑确认：bun test 文件参数不带 ./ 前缀时是子串过滤器**（会静默缩窄/错配文件集）——此前多轮"绿色"与伪红皆源于此，已写入全部后续简报；此前 15 fail 系 cwd 漂移+污染库伪影。checkpoint 224fix 已抓，rereview-224 派发（ctx_c1feed2c8908）。
- #346（21.2）：checkpoint 187 files；coordinator 复验 cleanup-classification + enumeration 11/11 + tsc 0 + 破坏性语句 grep 零命中；review-346 派发（ctx_26b50f039ab8）。
- 运行中：rereview-224、review-346、#291（10.2）、#243（05.2）。

## T62 — #224 集成完成（0133）（2026-10-17）

- rereview-224 F1 **CLOSED**（四处全修 + 断言可观察 + 37/37 独立复证）→ 集成：0130→**0133**（prevId 重链 0132，journal 134 链）。gateway.ts 教训：三方 merge-file 与朴素并取在"多票同文件加法"场景反复出错（imports 冲突 + 表体交错）——最终以 b5-224 worker 整洁版为底 + 正则提取 customers 块插入的**确定性重建**法通过（tsc 0）。后续同文件多票增量优先用此法。
- int19 @5594：域 113/113（price-snapshot/catalog/customers/readiness/rate/negotiation 八文件）。**#225（03.3 价格状态语义）解锁**。
- 运行中：review-346、#291、#243。

## T63 — #346 集成完成（fix 后）（2026-10-17）

- review-346：4/4 AC + 零破坏性证实，S1 MEDIUM（model_usage 书面确认缺）→ fix-346（模块头四要素落盘 + S2 边界说明）→ rereview **S1+S2 CLOSED**。集成 2 文件直复制；int20 @5594 11/11 + tsc 0。**#347（21.3）解锁**。
- #291（10.2）：worker 完成（回调归属接线、unowned_payout 扣发可重放、callback_unverified 零账务；自纠 5432 误用并 DROP 还原）；coordinator 复验 156/156 + 双 TC 0；review-291 已派发（ctx_b4d01d73cf0c）。
- 运行中：review-291、#243、#225。

## T64 — #291 集成完成（2026-10-17）

- review-291 双 PASS（质量 A；1 LOW=执行报告表述失实代码正确 + 4 INFO）→ 无回派。集成 6 文件直复制。int21 @5594：169/169（含 reconcile 全绿——8 文件组合在全新库无污染）+ tsc 0。**#292（10.3）解锁**。累计闭环 31 张：组 01/02/04 全组 + 03.1/03.2 + 05.1 + 10.1/10.2 + 21.1/21.2。
- 运行中：#243（05.2）、#225（03.3）。就绪待派：#292（10.3）、#347（21.3）。

## T65 — #225 验证完成；review-225/#292/#347 派发（2026-10-17）

- #225（03.3）：worker 完成（状态分类由 canonicalized dims 派生、0134 迁移三列+CHECK+backfill、free→known 按版本重分类、DB 拒篡改）；checkpoint 203 files；coordinator 复验 price-status-classification 37/37 + price-snapshot 回归 37/37 + 双 TC 0；review-225 派发（ctx_668943989190）。
- #292（10.3，ctx_6e00830af49a）、#347（21.3，ctx_0f00927536d3）派发，206 文件同步 0 mismatch；简报预占迁移号：#225=0134（待集成），#292 起用 0135+。
- 运行中：#243（05.2，最久）、review-225、#292、#347。

## T66 — #225 集成完成（0134）（2026-10-17）

- review-225 双 PASS（2 LOW+3 INFO；报告 /tmp→归档 reviews/b5-225.md）→ 集成 8 文件直复制（链预占 0134 完全对齐，首次零重编号集成）。int22 @5594：101/101 + tsc 0；迁移链 135。**#226（03.4 自动目录同步 last-good）解锁**。累计闭环 32 张。
- 运行中：#243（05.2）、#292（10.3）、#347（21.3）。

## T67 — 502 风暴×3 全量恢复（2026-10-17）

- 第四次 hiroute 上游 502 风暴：#243/#292/#347 三 worker 全部重试耗尽停摆。按"失联只算检查点"处置：abandon→ready→全新 worker-start（ctx_74b9bf95c5e0/ctx_b0699d737960/ctx_6fabe92f3870）+ 接续简报（盘点 worktree 未提交状态从断点续作）。

## T68 — 502 风暴持续，转入等待（2026-10-17）

- 风暴未止：三接续 worker 重启后再次"Retry failed after 3 attempts"死锁（hiroute-main no upstream candidate 持续 20min+）。判定为上游持续宕机，停止循环重派（只烧重试），工作树进度保留（#243 CH4.3%/#292 CH31%/#347 CH4.7%）。上游恢复后按 abandon→ready→restart+接续简报处置。
- 停机期动作：跨会话记忆已存（bun test ./ 前缀、双容器、502 纪律、jsonb 缺陷）。已闭环 32 张不受影响。

## T69 — 502 风暴结束，三 worker 恢复（2026-10-17）

- 上游恢复探测法：重启最小进度 worker（#347 → ctx_94970ac9a1da）确认工作正常后批量重启其余（#243 → ctx_d61f8864420a、#292 → ctx_77e4a4bd7476）。接续简报均提示前任崩溃库可能有残留行（用全新库名）。

## T70 — #347 集成完成（2026-10-17）

- review-347 双 PASS + 零破坏性双证实（0 中高危）→ 集成 3 文件直复制。int23 @5594：34/34 + tsc 0。**#348（21.4 清理计划/dry-run）解锁**。累计闭环 33 张：组 01/02/04 全组 + 03.1–03.3 + 05.1 + 10.1/10.2 + 21.1–21.3。
- 运行中：#243（05.2）、#292（10.3）。

## T71 — #347 集成完成 + #243 跨票表冲突裁决（2026-10-17）

- #347（21.3）：review 双 PASS + 零破坏性双证实 → 3 文件集成 → int23 34/34 + tsc 0。**#348（21.4）解锁**。累计 33 张。
- **#243 冲突裁决**：其同步层早于 #242 集成，worker 重建了同名 gateway_customers 表（external_reference + 3 态机 vs #242 的 name + 1 态 active）。终态设计=票面 Produces（3 态+关联键）即 #243 形状，但 #242 迁移已应用不可改 → 裁决为 **ALTER 演进**：rework-243（ctx_2fbfff858f1e）改 0135 迁移（ADD external_reference、扩 provision_state CHECK、customer_id 可空、双唯一索引）+ 模块改为消费 #242 seam。教训：**同依赖链的相邻票并行派发时，后票同步层若早于前票集成，会看不见前票产出**——05.x 后续票（05.3+）派发前必须确认 05.1/05.2 已集成或在其简报中附前置契约全文。
- 运行中：rework-243、#292（10.3）。

## T72 — rework-243 复验通过；review-243fix/#226/#348 派发（2026-10-17）

- rework-243（#243 05.2 ALTER 演进）：terminal 释放 + checkpoint **243fix**（195 files）。coordinator 复验 @5594 全新库 openbot_b5_243c：roles+migrate 过（0132→0135 链应用）、`./tests/customer-provision-recovery.test.ts ./tests/gateway-customer-provisioning.integration.test.ts` **33/33**（16 新 + 17 条 #242 回归）+ tsc 0。
- review-243fix 派发（ctx_2aa2a405254d @ b5-243，只读，报告 → reviews/b5-243fix.md）。审阅重点：0135 ALTER 与 #242 表形兼容（backfill reservation-guard、唯一索引一致性、snapshot/journal 链）、零重复创建语义（external_reference 关联键 + adoption 分支）、'active' 保留 + 读取归一化 'confirmed' 的健全性、RED→GREEN 证据链。
- **#226（03.4 自动 5 分钟同步 last-good）派发**（ctx_ec5ccdb5b43b @ b5-226；worktree 新建 + sync_delta 216 文件 0 mismatch；简报附 03.1–03.3 契约指针 + 环境纪律 + 本地迁移 0135 起号说明）。
- **#348（21.4 dry-run 输出与校验 hash）派发**（ctx_ce95890785ad @ b5-348；sync_delta 216 文件 0 mismatch；简报附 21.1–21.3 契约指针 + N+1 规模隐患评估承接 + 清理仅限专用测试数据）。
- #292（10.3 第三任 ctx_795f74eee1bc）存活且正常工作（正自纠测试 planCode bug；CH 99.6%，临近自动压缩，若死锁按 abandon→ready→restart+接续简报处置）。
- 运行中：review-243fix、#226、#348、#292。累计闭环 33 张（#243 待 review 后集成，届时 0135 重链 0134、#292 本地 0135+ 集成时重排）。

## T73 — 第二波补派：#222/#229/#252（2026-10-17）

- DAG 就绪计算（tickets.json blockedBy ⊆ 已集成集）：**#222**（02.8 管理员发放到指定个人账户，dep #221 ✓）、**#229**（03.7 管理员开放范围，dep #224 ✓）、**#252**（06.1 Reserve 服务身份认证，deps #224/#218/#217 ✓）。三票均建独立 worktree + sync_delta 216 文件 0 mismatch。
- 派发：#222 → ctx_95cf235f3019；#229 → ctx_967c42cc58d7（简报注明与 #226 的 catalog.ts 并行边界：只读消费不动同步入口）；#252 → ctx_afbb2290430f（简报附跨 Spec 付款方不可漂移裁决）。
- 运行中 7 个 dispatch：review-243fix、#226、#348、#292、#222、#229、#252。集成层不变（32 张已集成 + #243 待 review）。

## T74 — #243 集成完成（0135）（2026-10-17）

- review-243fix：**双 PASS（质量 A-）**，findings 3 low + 4 info（无 critical/high/medium，不触发修复轮）。亮点：reviewer 独立复验含升级路径模拟（存量 #242 库 → 只追加 0135、存量行无损）+ 生成列 backfill 论证 + RED 证据核验。遗留跟进项：low#1 预约删除缺 isNull 守卫（自愈路径）、low#2 invalid_response/5xx 应归 outcome-unknown、low#3 journal idx/tag 错位（集成层已按 idx 135/0135 规整）、info#6 生产 lookup 适配器须由下游接线票交付后方可启用。
- 集成：customer.ts/customer-provision.ts/recovery 测试/fake-gateway-customers/0135 SQL/plan 文档直复制；gateway.ts 按确定性重建法移植 gatewayCustomers 块（worker 版缺 #225 price_status——基线时差，块移植规避）；0135_snapshot.json = main 0134 + worker gateway_customers 表对象移植 + id/prevId 重链；journal 追加 idx 135（when+1000）。
- int24 @5594 全新库：migrate 全链过 + 六文件 **107/107**（recovery 16 + provisioning 17 + price-snapshot 2 文件 + price-status 2 文件）+ tsc 0 + biome 净 + introspection 证实 external_reference GENERATED ALWAYS AS (gateway_customer_name) STORED NOT NULL、gateway_customer_id 可空、provision_state 4 值 CHECK。**迁移链 136 条。累计集成 33 张。**
- 运行中：#226、#348、#292、#222、#229、#252。

## T75 — #229 验证完成；review-229 派发（2026-10-17）

- #229（03.7 管理员开放范围）：worker 完成（gateway_model_open_scopes 表[worktree 本地 0135]、model-scope.ts isModelOpen 双检查默认关闭、管理路由+审计、admin 目录页+i18n、price unknown 拒绝开放）。checkpoint 221 files；coordinator 复验 @5594 全新库 openbot_b5_229c：model-scope 14 + catalog/price-status 回归共 **50/50** + server/app 双 tsc 0。
- review-229 派发（ctx_e2c5b9f1928b @ b5-229 只读，重点：默认关闭语义、AC4 锁定快照不受影响、基线 2 失败归属证实、#226 并行边界核对）。
- 运行中：#226、#348、#292、#222、#252、review-229。#230（03.8）待 #229 集成后解锁。

## T76 — #226 验证完成；review-226 派发；接线裁决（2026-10-17）

- #226（03.4 自动同步 last-good）：worker 完成（catalog-sync.ts 周期任务+single-flight+状态行、gateway_catalog_sync_state[本地 0135]、18/18+45 回归）。checkpoint 220 files；coordinator 复验 @5594 全新库 openbot_b5_226c：7 文件 **115/115** + tsc 0。
- **接线裁决**：worker 因 index.ts 生产接线一行越界 ask 15 分钟未批复而搁置。coordinator 裁定：启动接线属票面要求的实施代码（非"网关能力启用"——后者指部署期启用），批准补齐；处置（本票 fix 轮 vs 并入 03.5）由 review-226 结论定。
- review-226 派发。运行中：#348、#292、#222、#252、review-229、review-226。#227（03.5）待 #226 集成后解锁。

## T77 — #229 集成完成（0136）（2026-10-17）

- review-229 双 PASS（质量高；7 findings 全 low/info）：AC1-4 全过、并行边界零越界（catalog.ts 逐字节一致）、schema.test 2 失败 A/B 铁证为基线既有（记遗留：credentials kind 枚举 + 0107 重编号，开基线责任票）。
- 集成：model-scope.ts/测试/admin-routes/audit/app 全套直复制（共享文件纯追加，reviewer 已核）；gateway.ts 追加 open scopes 块（首次提取断言失败未写入——块不在 worker 文件末尾，修正边界后成功，无半成品状态）；0135→**0136_gateway_model_open_scopes** 重编号 + snapshot 移植（main 0135 + open_scopes 表）+ journal idx 136。
- int25 @5594：migrate 过 + 6 文件 **79/79**（model-scope 14 + #243 域 33 回归 + catalog/price-status/admin-routes）+ server/app 双 tsc 0。**迁移链 137 条。累计集成 34 张。**
- 运行中：#348、#292、#222、#252、review-226。#230（03.8）解锁待派。

## T78 — #226 集成完成（0137）；#227 派发（含接线移交）（2026-10-17）

- review-226 双 PASS（质量 A；AC 4/4、单飞/原子计数/last-good 门禁组合均实证）。**裁决**：F2（medium，index.ts 调度器接线缺口）按 reviewer 建议不回派本票（票面 Write scope 不含 index.ts，worker 越界即停纪律正确），**强制移交 #227（03.5）**并附精确锚点（createApp :5326 之后、勿置于 installEnterpriseControls 与 createApp 之间否则静默不调度；SIGINT/SIGTERM 清单 :5852 同型）；F1（low，注释宣称不存在的 CHECK）一并移交 #227 修正。03.6（新鲜度门禁）语义依赖该接线，#227 完成前不解锁 03.6。
- 集成：catalog-sync.ts/catalog-auto-sync.test.ts 直复制；gateway.ts 追加 sync_state 块；0135→**0137_gateway_catalog_sync_state** + snapshot 移植 + journal idx 137。int26 @5594：10 文件 **162/162**（catalog 域 + model-scope + #243 域全回归）+ tsc 0。**迁移链 138。累计集成 35 张。**
- 运行中：#348、#292、#222、#252、#230。#227（03.5）派发。

## T79 — #252 验证完成；review-252 派发（2026-10-17）

- #252（06.1 Reserve 服务身份认证）：worker 完成（credit-service-auth.ts 唯一受信身份+轮换+常数时间比较+统一 401+失败审计；enum 迁移[本地 0135]；3 审计词表；8/8）。checkpoint 220 files；coordinator 复验 @5594 全新库 openbot_b5_252c：5 文件 **56/56** + tsc 0。
- worker 越界上报（audit.ts/enum/schema 三处纯新增）按纪律 ask 后继续并显著标注——reviewer 将裁定正当性。
- review-252 派发。运行中：#348、#292、#222、#230、#227、review-252。#253（06.2）待 #252 集成后解锁。

## T80 — 502 风暴×6 探针恢复；#226/#229 集成后波次推进（2026-10-17）

- 13:47 检出 hiroute 502 风暴复发：#292/#348/#222 三 worker 重试耗尽死锁；#230/#227/review-252 存活未受影响。工作树进度零丢失（盘点确认 62-64 modified + untracked 完好）。
- 探针法复用：重启最小进度 #222（ctx_38828283f1bf）4 分钟确认存活工作（正用 docker exec 解 psql 缺失）→ 批量重启 #348（ctx_96b710b69b41）、#292（ctx_85a17b8a6fa8，第四任）。接续简报均含：盘点断点续作、全新库名（崩溃库残留行）、./ 前缀纪律（#292 前任曾违）。
- 运行中 7：#222、#348、#292、#230（03.8）、#227（03.5 含接线移交）、review-252。

## T81 — #252 集成完成（0138）；#230 验证+review 派发；#253 派发（2026-10-17）

- review-252 双 PASS（质量 A；越界三处裁决正当、迁移 ADD VALUE 事务安全实证、基线 workshop.* 19 词表失败 A/B 定性）。集成动作照 reviewer 建议：0135→**0138_credit_service_credential_kind** 重编号 + **补齐 0138_snapshot**（enums.credential_kind += credit_service——修复 reviewer F3 手写迁移缺快照）+ audit.ts credit_service 块按锚移植（首轮脚本断言过严中止未写入——"dels"实为 main 侧 #229 增量属预期，改为锚点插入法成功）+ core.ts/credit-service-auth.ts/测试直复制；all-nums.txt 未带入。
- int27 @5594：migrate 过（枚举 9 值）+ 5 文件 **80/80** + tsc 0。**迁移链 139。累计集成 36 张。**
- #230（03.8）：worker 完成（model-capability-filter.ts 消费 isModelOpen/价格分类/目录 refs、4 原因码、isCatalogFresh seam；零修改既有文件无迁移）。checkpoint 231 files；复验 4 文件 **45/45** + tsc 0；review-230 派发（ctx_30277e2444aa）。
- **#253（06.2 事务内重验授权与价格依据）派发**（235 文件同步 0 mismatch；简报附 #252 endpoints 挂载缝 + 付款方不可漂移裁决 + 迁移 0139 起号）。
- 运行中：#222、#348、#292、#227、review-230、#253。

## T82 — #230 集成完成（无迁移）；#231 派发（2026-10-17）

- review-230 双 PASS（质量 A；2 low + 3 info）：四码封闭集、字面消费无漂移、requester 维度裁决正确（模型可选性是公司级目录数据，个人/公司分离由 04.x/02.x 承载）。**移交项**：03.6 接入时须把新鲜度门禁同时接入 isCatalogFresh seam 与执行准入（review F1，seam 签名需一行适配 assertCatalogFresh）；票面 checkpoint 补记按批次惯例统一处理（F3）。
- 集成：4 新文件直复制（模块+2 测试+plan），零共享文件、零迁移。int28 @5594：6 文件 **74/74** + tsc 0。**累计集成 37 张**（迁移链 139 不变）。
- #231（03.9 用户模型偏好层级）派发（dep #230 已集成）。
- 运行中：#222、#348、#292、#227、#253、#231。

## T83 — #222/#348/#227 验证完成；三 review 派发（2026-10-17）

- #222（02.8）：admin personal-grants 路由+UI+i18n+审计；checkpoint 222 files；复验 39/39 + tsc 0。
- #348（21.4）：cleanup-dry-run（三清单+sha256 绑定+fail-closed+脱敏）；checkpoint 219 files；复验 23/23 + tsc 0。N+1 量化：6000 记录≈110ms、报告 2.3KB、hash 输入 4.2MB——流式改造延后合理。
- #227（03.5）：手动同步路由+UI+审计；**两项移交完成**（接线 :5595 createApp 后 + :5873 停机清单，coordinator 核对锚点正确；F1 注释已修）。checkpoint 234 files；复验 50/50 + tsc 0。
- 裁决：#227 audit 词表 +1（gateway.catalog_sync_triggered）**批准**（同 #252 正当纯新增先例）；**5432 遗留同名测试库不触碰**（该端口曾致崩溃，留待用户处置，记遗留项）。
- 运行中：#292、#253、#231、review-222、review-348、review-227。#228（03.6）等 #227 集成；组 21 后续等 #348 集成。

## T84 — #231 验证完成；review-231 派发（2026-10-17）

- #231（03.9 用户模型偏好层级）：worker 完成（model-preference.ts 三层 用户→Bot→会话、写入经 03.8 逐字校验不可选即拒绝、gateway_model_preferences[worktree 本地 0140 避开 0139 预占]、24 用例；误建 5432 测试库已自纠 DROP）。checkpoint 243 files；coordinator 复验 @5594 全新库 openbot_b5_231c：4 文件 **62/62** + tsc 0。
- review-231 派发（ctx_26feb99bb349）。
- 运行中：#292、#253、review-222、review-348、review-227、review-231。#232（03.10）等 #231 集成。

## T85 — #231 集成完成（0139）（2026-10-17）

- review-231 PASS（A-；F1 medium=重编号三处同步改名——已照办：SQL/journal/meta snapshot 文件名齐改 0140→**0139_gateway_model_preferences**，集成层 idx 连续无跳号；F3 low=补"存量偏好变不可用不回落"测试——**移交 #232**；基线 3 红已 reviewer 定性与本票零牵连）。
- 集成：model-preference.ts/测试直复制；gateway.ts 追加 preferences 块；int29 @5594：7 文件 **98/98** + tsc 0。**迁移链 140。累计集成 38 张。**
- #232（03.10 选择器与不可用报错）派发（含 F3 移交：model-preference.integration.test.ts 补 1 用例）。
- 运行中：#292、#253、review-222、review-348、review-227、#232。

## T86 — #253 验证完成；review-253 派发（2026-10-17）

- #253（06.2 Reserve 事务内重验）：worker 完成（credit-reserve.ts 五类事务内重验+同事务预留、11 拒绝码、/reserve 经 06.1 守卫；26/26+89 回归）。checkpoint 238 files；coordinator 复验 @5594 全新库 openbot_b5_253c：6 文件 **105/105** + tsc 0。
- 注意点（review 将裁定）：worker 自报 03.6 门禁缺失而在 Reserve 内实现 freshness 拒绝并留替换 seam——与 #228（03.6）设计边界、review-230 F1 的接入要求需对齐。
- review-253 派发。运行中：#292、#232、review-222、review-348、review-227、review-253。#254/#255（06.3/06.4）等 #253 集成。

## T87 — #253 集成完成；#254 派发（06.4 串行决策）（2026-10-17）

- review-253 双 PASS（A-；2 Low + 6 Info）：事务边界三重实证（FOR SHARE+SAVEPOINT+双注入测试）、拒绝零写入结构性保证（FK 不变式）、新鲜度内联不越界+seam 可替换。**移交项**（F3，随 #228 简报下发）：03.6 须把 credit-reserve.ts 第 4 步当执行准入集成点、删除内联谓词保单真相、同时接 isCatalogFresh seam；F1（测试 afterAll 前缀清理失效致共享库残留累积）→ **移交 #254**；F2（writer 类型双重断言）记技术债。
- 集成：credit-reserve.ts/reserve-revalidation 测试/plan 直复制（无迁移，链 140 不变）。int30 @5594：5 文件 **87/87** + tsc 0。**累计集成 39 张。**
- **#254（06.3 原子预留与账户行锁）派发**（dep #253 已集成；简报含 F1 移交）。**#255（06.4）同域串行**——与 #254 都会改 credit-reserve.ts，避免同文件并行冲突，#254 集成后解锁（覆盖 DAG 上的仅 253 依赖，记策略性串行）。
- 运行中：#292、#232、review-222、review-348、review-227、#254。

## T88 — 502 风暴×7 探针恢复（2026-10-17）

- 15:31 检出：review-222/review-348/review-227/#292 四 worker 重试耗尽死锁（#232 ×2 次 retry-failed 但 liveness live，暂观察）；#254 健康。工作树零丢失。
- 探针：review-222 重启（ctx_f0d6bc8f1260）4 分钟确认存活 → 批量重启 review-348（ctx_9e7650781121）、review-227（ctx_82c27b1b0c44）、#292 第五任（ctx_77b754eaf767），接续简报齐发。
- 运行中：review-222、review-348、review-227、#292、#232（观察）、#254。

## T89 — #254 验证完成；review-254 派发（2026-10-17）

- #254（06.3）：worker 判定 #253 写入路径已具备原子性（payerKey 确定性+billing_customers FOR UPDATE）→ **生产代码零改动**，交付=真并发证明测试（31 pass，变异注入 RED）+ **F1 修复**（253 测试 afterAll 派生键前缀；修复前 53 行残留→0）。checkpoint 248 files；coordinator 复验 @5594：4 文件 **40/40** + tsc 0 + 跑后双表 0 残留（F1 修复实证）。
- review-254 派发（重点裁决"零改动即满足"形态）。运行中：review-222、review-348、review-227、#292、#232（观察）、review-254。

## T90 — #222/#348 集成完成；合并事故三起与修复（2026-10-17）

- review-222 双 PASS（高；5 low/info：解析即契约三层结构性保证）；review-348 双 PASS（A；F1 Low-Medium hash 覆盖文案过度声明 + F2 对齐断言 + F3 覆盖缺口 → **移交 #349**；F5 流式改造立独立票、F6 继承双读漂移记 21.5 兜底）。
- **合并事故（本日三次，全部当场修复）**：①admin/index.tsx 锚点"IconCode,"过弱 → JSX 块误插 import 区（修复：保留 IconCoins import+精确上下文重插）；②routeTree.gen.ts 缩进启发式错位（修复：b5-229 基线恢复+difflib insert-only 合并；replace 段跳过为 #229 保留——tsc+UI 17/17 实证通过，残余风险留终局全分支审阅）；③audit.ts 锚点末次匹配错位且误删既有注释开头（修复：granted literal 后正确插入+补回被吃 /**）。**教训：锚点必须用多行上下文匹配（≥3 行）+插入后立即 tsc 验证，不再用单行锚。**
- 集成：#222（index.ts/app.ts/billing routes 直复制 + audit/admin 页/locales/routeTree 合并 + 新文件）；#348（3 新文件直复制）。int31 @5594：server **70/70** + app UI **17/17** + 双 tsc 0。**累计集成 41 张**（迁移链 140 不变，两票均无迁移）。
- 运行中：review-227、#292、#232、review-254、review-222→已完成释放。#349（21.5）解锁待派。
- 更正：#349（21.5）deps=[259,348]——259（06.8）未集成，**未解锁**；21.x 后续链头在 06.x 链推进后自然就绪。

## T91 — #254 集成完成；#255 派发（2026-10-17）

- review-254 双 PASS（A-，0 Low + 7 Info）："零改动即满足"判定逐条成立、变异 RED 诚实、F1 修复正确。Info#4 备案：reserve×settle 理论锁序窗口留 06.7/恢复路径票。
- 集成：2 测试文件 + plan 直复制（无生产代码改动）。int32 @5594：3 文件 **39/39** + tsc 0 + 跑后 0 残留。**累计集成 42 张**（迁移链 140）。
- **#255（06.4 篡改 payer 与自报账户的冲突语义）派发**（253/254 均已集成，串行策略解除）。
- 运行中：review-227、#292、#232、#255。

## T92 — #255 验证完成；review-255 派发（2026-10-17）

- #255（06.4 payer 冲突语义）：worker 完成（payer_conflict 封闭码、严格 {kind,id}、7 禁带账户键参数拒绝、审计行；修复"伪造账户得 201"缺陷）。checkpoint 260 files；coordinator 复验 @5594：5 文件 **76/76** + tsc 0。
- review-255 派发。运行中：review-227、#292、#232、review-255。

## T93（2026-10-17）
- #255（06.4 篡改 payer 冲突语义）闭环完成：review-255 双 PASS（Spec 4/4 + 质量 A-，报告 .omc/research/bifrost5/reviews/b5-255.md）。
- 集成：credit-reserve.ts / reserve-revalidation.integration.test.ts / reserve-payer-tampering.test.ts 直复制（哈希核验一致）；audit.ts 多行锚插入 credit_reserve.payer_conflict 词表（credit_service.refused 三词条后）；index.ts diff 确认无 #255 增量（纯基线时差，未动）。
- 集成库回归 @5594 全新库 openbot_b5_255i（140 迁移 + roles）：tampering+revalidation 35/35、tsc 0、audit.test 7/8（唯一红=workshop.* 存量词条，reviewer 已定性基线既有）。
- 环境事实更新：主仓库旧集成层已被用户提交（a18e2711/65e8d57c/563fe88d merge），当前未提交层仅 #255 增量 7 文件；worktree 基线=HEAD+sync_delta 增量，完整无损。
- #256（06.5 上限取整与版本锁定）解锁并派发：worktree b5-256、task_6c752957caf9、worker ctx_a929021e5263。简报含纯函数边界、足额取整方向、版本锁定禁漂移、TEST_DATABASE_URL 与 ./ 前缀纪律。
- 运行中：review-227（ctx_82c27b1b0c44 第二任）、#292（ctx_77b754eaf767 第五任 10.3）、#232（ctx_cdf1b0234e75 03.10）、#256（ctx_a929021e5263）。

## T94（2026-10-17）
- 502 风暴×8：review-227（第二任）与 #232（第五任）双双 "Retry failed after 3 attempts" 死锁。按探针纪律恢复：review-227 探针重启（第三任 ctx_7d9dc308c461，4 分钟 live 确认上游恢复）→ #232 批量重启（第六任 ctx_d4b84dd32455 + 接续简报：218 未提交文件盘点续作、全新库名 openbot_b5_232r2_、./ 前缀）。零工作丢失。
- #256（06.5 上限取整与版本锁定）实施完成：reserve-bound.ts computeReservationCeiling（12 维 BigInt 精确有理数、唯一取整步=足额向上、无效量/未知维/非法比例/超 32-bit 拒绝码）；0140_reservation_locked_basis 迁移（locked basis cell+snapshotVersion+rateVersion，all-or-nothing CHECK）；resolveLockedReservationBasis 只读不可变版本化存储 + 源码扫描测试结构性禁读最新价；中途改价改比例仍按 v1 结算集成测试实证。
- 闭环前半：release → checkpoint 256（15 文件/42KB）→ coordinator 复验 @5594 全新库 openbot_b5_256c（141 迁移）：24/24 新测试 + 35/35 回归（255 tampering+revalidation）+ tsc 0 → review-256 派发（task_849491b63218，ctx_3c3e2052ce13，重点：12 维完整性找漏维、CHECK 一致性、源码扫描测试约束力与绕过路径、legacy callers 实证、RED 日志真实性）。
- 运行中：review-227（ctx_7d9dc308c461）、#292（ctx_77b754eaf767）、#232（ctx_d4b84dd32455）、review-256（ctx_3c3e2052ce13）。

## T95（2026-10-17）
- #227（03.5 管理员立即同步）集成完成（第 43 张）：review-227 第三任双 PASS（Spec 4/4 + 质量 A，1 LOW+4 INFO 无阻塞；报告 reviews/b5-227.md）。
- 集成明细：直复制 catalog-sync.ts（F1 注释修正，last_failure_reason_code 无 CHECK 实证正确）/admin-routes.ts/mutations.ts/3 新增文件；audit.ts 词表 gateway.catalog_sync_triggered（model_scope_changed 后多行锚）；index.ts 三处接线（import/createApp 后 scheduler 块含防回归注释/signal handler stop，三锚 count==1 断言）；locales en+zh-CN admin.json 深合并（modelCatalog.sync.* 各 7 键，0 冲突）；routeTree difflib 合并；model-catalog.tsx 直复制（worktree 版含主仓库全部语义）。
- 事故与修复：首轮回归 UI 0/4——model-catalog.tsx 漏合并（diff 统计时遗漏该文件），复制后 4/4；bun test 多过滤器单文件坑再现（model-scope.test.ts 实为 .integration 版），修正后 3 文件 44/44。
- Orca 重启中断：routeTree 写入完好，app tsc 137 被 kill 后复跑 0；3 运行中 dispatch（#292/#232/review-256）全部存活无损。
- 集成库回归 @5594 openbot_b5_227i（140 迁移+roles）：catalog manual+auto 26/26、audit 7/8（workshop.* 存量红）、scope/preference/capability integration 44/44、UI 4/4、server+app tsc 双 0。
- #256 闭环前半已记 T94；运行中：#292（ctx_77b754eaf767）、#232（ctx_d4b84dd32455）、review-256（ctx_3c3e2052ce13）。
