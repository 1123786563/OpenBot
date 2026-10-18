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
- #228（03.6 目录新鲜度门禁）解锁并派发：worktree b5-228（sync_delta 17 文件）、task_03401b615293、ctx_47adfb156ed6。简报含 review-253 F3 + review-230 F1 双接入移交项（credit-reserve 准入集成点+catalogFreshnessWindowMs 装配+isCatalogFresh seam）、#256 未集成警告（勿依赖 0140）。

## T96（2026-10-17）
- review-256 结果：Spec PASS 4/4（核心换算与锁定语义无需返工）但质量 FAIL——F1 HIGH（0140 缺 meta snapshot，migration-journal.test 2 红未披露）+ F2 MEDIUM（all-or-nothing CHECK 被 SQL NULL 三值逻辑击穿，半锁行落库实证）+ F3-F6 低。→ fix-256 派发（task_71b5e5b5d2d3，ctx_d2ef9693db5b，同 worktree 续作：补 snapshot、CHECK 改 NULL 安全、DB 级拒绝测试）。
- #292（10.3 订阅归属与续期到账）第五任完成：激活时服务端标记所有权（0134 迁移列，callbacks/clients/projection 不可重写）、plan-renewal:<subId>:<periodStart> 周期幂等键、plan_grant_owner_mismatch 对账发现；附带修复继承测试 ORDER BY 不稳定 + 清理前任 5432 测试残留 480 万行（环境操作，无生产触碰）。
- 292 闭环前半：release → checkpoint 292（217 文件/269KB，HEAD=bab7c0b9 本地 docs commit，未提交 diff 为交付面）→ coordinator 复验 @5594 全新库 openbot_b5_292c（135 迁移+roles）：4 域测试 28/28 + billing-reconcile 28/28（232s）+ tsc 0 → review-292 派发（task_2b08609e12d3，ctx_44b7c69ebd5d）。
- 集成预警：#292 worktree 本地迁移号 0130-0134 与集成层冲突，集成时重编号至 0141+，0132_gateway_customers 需与主仓库既有 gateway_customers 演进对齐核对。
- 运行中：#232（ctx_d4b84dd32455）、#228（ctx_47adfb156ed6）、fix-256（ctx_d2ef9693db5b）、review-292（ctx_44b7c69ebd5d）。
- #232（03.10 模型选择器与不可用错误）第六任完成：继承前任 server 侧（display contract GET+PUT 偏好写 18 契约+F3 no-fallthrough 25 回归，验证绿不重做）+ 本任 TDD 建 app 侧（queries 封装/model-picker 组件/i18n en+zh-CN/8 条 UI 测试：三层徽章、closed 5 码、无静默替换、unknown price 不渲染 free）。
- 232 闭环前半：release → task completed → checkpoint 232（250 文件/257KB）→ coordinator 复验 @5594 全新库 openbot_b5_232c：UI 8/8 + server model-selection/preference 43/43 + 双 tsc 0 → review-232 派发（task_454429a9810e，ctx_7d6c6623600c）。
- 运行中：#228（ctx_47adfb156ed6）、fix-256（ctx_d2ef9693db5b）、review-292（ctx_44b7c69ebd5d）、review-232（ctx_7d6c6623600c）。

## T98（2026-10-17）
- #232（03.10 模型选择器与不可用报错）集成完成（第 44 张）：review-232 双 PASS（Spec 4/4 + 质量 A-，1 Low+4 Info 无阻塞；突变复证 M1-M4 精确捕获无静默替换/未知≠免费不变量；报告 reviews/b5-232.md）。
- 集成明细：直复制 9 文件（model-picker.tsx/queries.ts/UI 测试/plan/model-selection-routes.ts+测试（前任交付）/model-access.tsx/model-preference F3 测试/票面）；app.ts 双锚合并（import + /api/model-selection 挂载块）；locales settings+errors en/zh 深合并（modelPicker.*/modelSelection.*）；catalog-sync/mutations/admin-routes/model-catalog/audit/index 确认基线时差跳过。
- 集成库回归 @5594 全新库 openbot_b5_232i（140 迁移+roles）：selection+preference 43/43、UI 8/8、scope/capability 回归 20/20、server+app tsc 双 0。
- 事故：queries.ts cp 失败（目录不存在）→ mkdir 补齐哈希一致；app/ 下误跑 server 测试（bun 过滤器坑变体）→ server/ 重跑全绿。
- review-232 终端 buffer 截断于中途但报告已落盘+dispatch succeeded（以 worker-show 为准推进）。
- 运行中：#228（ctx_47adfb156ed6）、fix-256（ctx_d2ef9693db5b）、review-292（ctx_44b7c69ebd5d）。
- #233（03.11 Bot 侧模型发现 API）解锁并派发：worktree b5-233（HEAD 9c7868e2——用户又推进了主仓库 HEAD，sync_delta 31 文件补齐）、task_503e4b72c76e、ctx_8f4108280488。简报含字段一致性强约束（白名单式构造）、复用 03.8/03.7 判定不复制。
- #233（03.11 Bot 侧模型发现 API）实施完成：/api/model-discovery（Bearer obot_bsvc_），401 同形防枚举、503 语义链、能力匹配+开放+价格可判三重过滤、逐层键白名单、no-store；判定全复用 03.8/03.10/04.2 seam 无复制。8/8+57/57+22/22+双 tsc 0+lint 0。
- 环境注意：worker_done 未入本 run 队列（Orca 重启余波），以 worker-show succeeded+票面 Checkpoint 填写+产出实证推进。
- 233 闭环前半：release → task completed → checkpoint 233（34 文件/85KB）→ coordinator 复验 @5594 全新库 openbot_b5_233c：discovery+selection 26/26 + tsc 0 → review-233 派发（task_c658e3b2421a，ctx_c003a914c34c）。
- 运行中：#228（ctx_47adfb156ed6）、fix-256（ctx_d2ef9693db5b）、review-292（ctx_44b7c69ebd5d）、review-233（ctx_c003a914c34c）。

## T99（2026-10-17）
- review-233 双 PASS（Spec 4/4 + 质量 A-；突变 M1-M3 精确捕获泄露面/收窄语义/认证门，M4 存活=Low finding 防御分支未钉；2 Low+3 Info 无阻塞）。
- #233（03.11 Bot 侧模型发现 API）集成完成（第 45 张）：直复制 model-discovery-routes.ts+测试；app.ts 双锚追加（import + /api/model-discovery 挂载块）；集成库回归 @5594 openbot_b5_233i：discovery+selection 26/26 + tsc 0。
- 运行中：#228（ctx_47adfb156ed6）、fix-256（ctx_d2ef9693db5b）、review-292（ctx_44b7c69ebd5d）。
- 下一波三张派发（#233 集成解锁）：#244（05.3 每授权独立 Key，task_0aaae5b003b0/ctx_c0adf6f36336）、#258（06.7 Status 查询与同 ID 恢复，task_7817d1ef4da2/ctx_2c9018dcc7c4，注明 #256 未集成勿依赖 0140）、#264（07.1 准入扩展挂载，task_9b75614e0c45/ctx_ae410b6296e5，bifrost 主战场硬拒绝语义）。#293（10.4）就绪但与 #292 同域暂缓至 review-292 落定。
- 运行中 6：#228、fix-256、review-292、#244、#258、#264。
- #258（06.7 Status 查询与同 ID 恢复）完成并闭环前半：reservation-status.ts（纯函数 attemptId 映射无迁移、grant 定界越权保护一律 unknown、只读双 SELECT）、credit-reserve.ts 4 处定点（删 generateAttemptId、statusService 槽位、POST /status 挂载）；14/14+78/78+tsc 0+lint 0+九表 0 残留。release→checkpoint 258（36 文件/86KB）→复验 @5594 openbot_b5_258c：status+revalidation+tampering 49/49+tsc 0→review-258 派发（task_642bdd2e2f6a，ctx_ebdee99fd7ed）。
- 注意：Checkpoint 有时填 '- **Checkpoint**：' 列表项而非 '### Checkpoint' 标题——核查产出时两种格式都要查。
- 运行中 7：#228、fix-256、review-292、#244、#264、review-258。

## T100（2026-10-17）
- review-258 双 PASS（Spec 4/4 + 质量 A-，高0/中0/低3；报告 reviews/b5-258.md）。
- #258（06.7 Status 查询与同 ID 恢复）集成完成（第 46 张）：credit-reserve.ts 4 处定点直复制（diff 逐一核对恰为本票增量）+ reservation-status.ts + 集成测试；集成库回归 @5594 openbot_b5_258i：status+revalidation+tampering 49/49 + tsc 0。
- 运行中：#228（ctx_47adfb156ed6）、fix-256（ctx_d2ef9693db5b）、review-292（ctx_44b7c69ebd5d）、#244（ctx_c0adf6f36336）、#264（ctx_ae410b6296e5）。
- #259（06.8 unknown hold 不超时回收）解锁并派发：worktree b5-259（HEAD 44754feb 用户又推进+sync_delta 5 文件）、task_16f16f05ba5c、ctx_79c7e15201f8。
- 运行中 6：#228、fix-256、review-292、#244、#264、#259。
- 429 速率限制事件（第 9 次上游故障，与 502 同构）：#228 与 fix-256 消息投递被拒。#228 数分钟自愈继续工作；fix-256 停滞 9+ 分钟 → 按失联纪律 abandon+重启（第七任 ctx_a096c6034ec8+接续简报：F2 CHECK 已落地确认、F1 snapshot 未建、DB 级实证测试待补）。
- 运行中 6：#228（ctx_47adfb156ed6）、fix-256（ctx_a096c6034ec8）、review-292（ctx_44b7c69ebd5d）、#244（ctx_c0adf6f36336）、#264（ctx_ae410b6296e5）、#259（ctx_79c7e15201f8）。
- #264（07.1 准入扩展挂载）实施完成：bifrost 子模块 governance 域 creditadmission（开关/版本声明/付费三态判定）、Evaluate 门装配（身份后 grant 前、keyless 同门）、credit_admission_not_enabled 503 决策、12 测试+竞态+vet 干净；server tsc 0。两项裁决请求：Q1 块缺失=硬拒绝（coordinator 裁决维持票面字面）；Q2 transports 层 version 透传 15 行越界（移交 review-264 裁定）。集成期警告：版本 bump 后 transports DK-12 测试需一行装配。
- 264 闭环前半：release → checkpoint 264 → coordinator 复验（go test -C plugins/governance -count=1 全量 20s ok + Admission ok + vet 0；坑：bifrost 多模块根无 go.mod 必须用 -C plugins/governance）→ review-264 派发（task_58885d118a2b，ctx_d6f765f8021c）。
- 运行中 6：#228、fix-256（ctx_a096c6034ec8）、review-292、#244、#259、review-264。

## T101（2026-10-17）
- review-264 双 PASS（Spec 4/4 + 质量 A-）：门真实性=core 装配证据链（五处 RunLLMPreHooks+tryRequest 每尝试+short-circuit 先于 provider）；裁决 Q1 维持硬拒绝（票面+父 Spec fail-closed 规范性）、Q2 移交独立票（transports /api/plugins version 透传，07.12 阻塞项，07.2 不受阻）；L1 骑 07.2 一行（负费率→pricingUnknown）；I1 部署档案不挂 semanticcache/routing。
- #264（07.1 准入扩展挂载）集成完成（第 47 张）：bifrost 子模块 governance 5 文件直复制（creditadmission.go/测试/main.go/resolver.go/providerscopedlimits_test.go 适配）；集成复验 go test -count=1 全量 18s ok + vet 0。
- 待立票：transports version 透传（Q2 裁决）；待 07.2：L1 一行加固。
- Q2 独立票已立：docs/tickets/bifrost-5/issues/07.1b-transports-plugin-version.md + task_8c3767e7c833（暂不派发，07.12 前落地）。
- #265（07.2 PreLLM 认证并申请预留）派发：task_18a91c6886aa/ctx_8198021fbaf6。**子模块坑两起**：①sync_delta 不覆盖子模块内未提交修改（os.path.isfile 跳过目录）；②worktree 子模块未初始化+git submodule update --init 网络卡死后台竞争覆盖 rsync 结果。修复法=直接 rsync 主仓库 bifrost 工作树+重复制 5 文件（后台任务已死无竞争），实测 governance 测试 ok；.git 相对指针失效（git 不可用，go 编译无碍）。教训：bifrost 域 worktree 基线=rsync 主仓库 bifrost/，勿用 submodule update。
- 运行中 6：#228、fix-256、review-292、#244、#259、#265。
- #259（06.8 unknown hold 不超时回收）完成并闭环前半：0141 迁移（unknown 态+3 CHECK+snapshot 齐，避让 0140 且不依赖其列）、credits-writer markUnknown/releaseUnknown/Release 拒 unknown、capacity held 无视 expires_at、status 含 unknown、index gate fail 先 mark unknown；audit.ts 基线缺口（sync_delta 遗漏 payer_conflict）自愈修复。RED 7/7→GREEN 7/7、回归 59/61（2 红=预占 0140 ENOENT 待 #256 集成即愈）、九表 0 残留。release→checkpoint 259（15 文件/56KB）→复验 @5594 openbot_b5_259c：unknown-hold+reservation-status 21/21+tsc 0→review-259 派发（task_27230ccf645b，ctx_f3f7eb606559）。
- 环境注意：用户主仓库 HEAD 推进至 44754feb（=9c7868e2+PR#401）。
- 运行中 6：#228、fix-256、review-292、#244、#265、review-259。
- #265（07.2 PreLLM 认证并申请预留）完成并闭环前半：creditadmission.go 555 行（Reserve 门配置/L1 负费率→pricingUnknown 加固/明确免费不预留·付费+未知过门/无乐观放行）、creditreserve_test.go 471 行 9 测试+fake 计费服务、attemptId bfat-+sha256 稳定生成作 idempotencyKey、credit_reserve_not_held 拒绝路径；**子模块二次清空事故由 worker 自愈**（杀掉竞争 setup shell PID 55411+从 b5-264 本地 fetch 恢复+#264 增量 sha256 核验重放+修 gitdir）。release→checkpoint 265（7 文件/47KB）→复验：governance 全量 29s ok+vet 0→review-265 派发（task_2a6179e3cff5，ctx_08e9a6ec2467）。
- 运行中 6：#228、fix-256、review-292、#244、review-259、review-265。

## T102（2026-10-17）
- review-265 双 PASS（Spec 4/4 + 质量 A-）：201 回显五字段先验证再落戳、拒绝路径唯一出口+突变 M1/M2a/M2b/M3/M6 全红、attemptId 纯函数稳定（突变 M3 红）、bfat-+32hex 满足 server isIdentifier 形状。
- #265（07.2 PreLLM 认证并申请预留）集成完成（第 48 张）：bifrost governance 6 文件直复制；集成复验 governance 全量 22s ok+vet 0。review-264 L1 骑缝项（负费率→pricingUnknown）已随本票落地。
- 运行中：#228、fix-256、review-292、#244、review-259。
- #266（07.3 未预留 short-circuit 拒绝语义）派发：worktree b5-266（bifrost 子模块 rsync 法基线全量验证 19.5s ok）、task_667d10eef1f1、ctx_a3a68a34a46b。
- 运行中 6：#228、fix-256、review-292、#244、review-259、#266。
- fix-256 完成：F1（0140_snapshot.json 建齐，0140 红清零；剩 1 红=基线既有漂移——净 HEAD 复现实证 13 历史条目 224 问题 0140 零涉及，coordinator 裁决维持现状记基线债池）；F2（CHECK NULL-safe by construction+DB 级实证测试 :545 direct INSERT 半锁违反约束，注释点名 review-256 抓的 NULL 洞）。coordinator 复验 @5594 openbot_b5_256c2：migration-journal 8 例 1 fail（=裁定基线债）+bound/version-locking 25/25+tsc 0 → review-256-fix 第二轮派发（task_42a32afd5188，ctx_7a94ef9185c9）。
- 运行中 6：#228、review-292、#244、review-259、#266、review-256-fix。

## T103（2026-10-17）
- review-256-fix 第二轮 PASS（F1/F2 修复到位无回归披露完整；口径 222 条目数勘误）。
- #256（06.5 上限取整与版本锁定，含 fix 轮）集成完成（第 49 张）：直复制 reserve-bound.ts/两测试/0140 SQL+snapshot/credits-writer/credit-reservations schema；credit-reserve.ts 三向合并（仅 lockedBasis 9 行块锚点插入，#258 增量保留）；_journal 追加 0140（141 条）；注释差异（worktree 改写 vs 主仓库预告注释）保留主仓库版不并。
- 集成库回归 @5594 openbot_b5_256i（141 迁移+roles）：bound+version-locking 25/25、#258 回归 status+revalidation+tampering 49/49、migration-journal 8 例 1 fail（=已裁定基线债）、tsc 0。
- 运行中：#228、review-292、#244、review-259、#266。
- #266（07.3 未预留 short-circuit 拒绝语义）完成并闭环前半：creditrefusal.go 五 reasonCode 封闭词表+12→5 映射（未识别归 admission_unreachable）、全部拒绝出口携 ReasonCode、EvaluationResult.ReasonCode 字段、creditRefusal() 构建器（error.code+AllowFallbacks=false）、11 测试（含 allowed 对照组+无泄露四类）。复验 governance 全量 23s ok+vet 0。**checkpoint 0 文件事故**：bifrost/.git 相对指针在 worktree 失效致父仓 git status fatal → 修绝对指针后重 checkpoint（10 文件/52KB；rsync 法建 worktree 后必须先修 gitdir）。review-266 派发（task_cfb17be94786，ctx_fe2518ad7bec）。
- 运行中：#228、review-292、#244、review-259、review-266。
- review-266 双 PASS（Spec 4/4 + 质量 A-；12→5 映射 1+4+4+1+2 全覆盖、突变 M1-M5 全红含 M4b 双层防御定性）。
- #266（07.3 未预留 short-circuit 拒绝语义）集成完成（第 50 张）：governance 5 文件直复制；集成复验全量 34s ok+vet 0。
- #267（07.4 dispatch 承诺持久化与幂等 claim）派发：worktree b5-267（rsync+修 gitdir 一次到位，基线 43s ok）、task_1def62eb4686、ctx_bcedc226d58b。
- 运行中：#228、review-292、#244、review-259、#267。
- #267（07.4 dispatch 承诺持久化与幂等 claim）完成并闭环前半：DispatchCommitment{attemptId,reservationId,provider,model,claimedAt,pending,grantId,payer,上限,版本}+Store 接口（Claim 幂等/ListPending 08.x seam）+进程内实现；claim 接入 201 分支先承诺后派发；重复 claim→dispatch_already_claimed 503；store 失败→fail-closed。复验全量 89.6s ok+vet 0 → review-267 派发（task_32bd6a1e4fda，ctx_2a119a04faee，重点：并发 claim 原子性、pending 无 requeue 路径扫描、五词表归类正当性）。
- 运行中：#228、review-292、#244、review-259、review-267。

## T105（2026-10-17）
- review-267 双 PASS（Spec 4/4 + 质量 A-：claim 位置=201 后 ctx 戳前放行前、32 goroutine -race 单胜出、pending 无迁移路径整树 diff 证实、字段=票面 Produces+归属+预留基准；进程内限定已声明，持久化后端经 store seam=Q-2）。
- #267（07.4 dispatch 承诺持久化与幂等 claim）集成完成（第 51 张）：governance 6 文件直复制；集成复验全量 45.6s ok+vet 0。
- #268（07.5 重试需新准入）派发：worktree b5-268（rsync+修 gitdir 一次到位）、task_4e9d6353b350、ctx_4786faa54bc2。
- 运行中：#228、review-292、#244、review-259、#268。
- #268（07.5 重试需新准入）完成并闭环前半：核验型+扩展型混合（fallback 每 slot 新 attemptId 已由 #265/#267 结构保证——核验成立；增量=DispatchCommitment 重试链四字段+commitDispatch 落盘，71 行恰在 dispatchcommit.go，creditadmission 等 0 差异）；5 新测试（双预留/旧标识拒/三 link 归属不变/重试准入失败不执行/attemptIdentity 映射）。复验全量 25s ok+vet 0 → review-268 派发（task_f57fc24fb20d，ctx_61bceea899f0）。
- 运行中：#228、review-292、#244、review-259、review-268。
- 静默卡死事件（第 10 次故障，新形态）：#228/review-292/#244/review-259 四 dispatch 终端 1.5 小时零输出且状态 [ready] 无 Retry 标志（429 余波后 idle 挂起）。按失联纪律全量重启：review-259 探针（ctx_8b2722f929a8，4 分钟确认在读 0141 内容存活）→ 批量 228（ctx_868851f0e4e4）/review-292（ctx_6e263ebd7ed0）/244（ctx_95ac5e2ca73f）+ 三份接续简报（#228 附 0141 冲突警告与 0140 已集成事实）。
- 运行中 4：#228、review-292、#244、review-259。
- #244（05.3 每授权独立 Key 签发）完成并闭环前半（两任失联后第三任续作）：key-issuance.ts（issuer+vk 客户端+/keys 路由）、5 测试、0140_gateway_virtual_keys.sql（本地号，集成时重编 0142——0140=#256 已集成、0141=#259 待集成）。release→checkpoint 244（43 文件/96KB）→复验 @5594 openbot_b5_244c：5/5+tsc 0→review-244 派发（task_fd1bf2f0860a，ctx_4d23c57e0620）。
- 运行中 4：#228（ctx_868851f0e4e4）、review-292（ctx_6e263ebd7ed0）、review-259（ctx_8b2722f929a8）、review-244（ctx_4d23c57e0620）。

## T106（2026-10-17）
- review-292 第二任双 PASS（Spec 4/4 + 质量 B+，1 MEDIUM F1=migration-journal 红未披露——定性为基线既有+前序票本地号快照缺陷，集成层重编号+snapshot 重建自然消解，无需 worker 返工；3 low/4 info）。
- #292 集成重编号计划确定：worktree 本地 0130-0133 实为主仓库已集成内容（sync_delta 复制），唯一新迁移 0134_subscription_owner_allowance → 集成层 **0142**；#259 的 0141 先集成、#244 的 0140_gateway_virtual_keys → 0143。集成顺序：#259 → #292 → #244。
- 运行中：#228（ctx_868851f0e4e4）、review-259（ctx_8b2722f929a8）、review-244（ctx_4d23c57e0620）。
- 静默卡死×2（第 11 次故障）：三 dispatch（#228/review-259/review-244）终端 30-40 分钟零输出。探针 review-259（ctx_aaad11d667cd）确认存活后批量：#228 第三任+review-244 第二任，各附接续简报（228 附迁移号≥0141 已被认领警告）。

## T107（2026-10-17）
- #292（10.3 订阅归属与续期到账）集成完成（第 54 张）：直复制组 maintenance/payments-service/types/schema-billing/store（worktree import 行本为 main 超集含 count+sql，无需修补）+3 新增（plan-renewals.ts/plan-renewal-grantor.test/subscription-ownership.integration.test）+billing-store.test（wt 版含 main 全部 updatedAt 期望，超集直复制）；service.ts/reconcile.ts 核实分叉后主仓库零提交零未提交修改、main-only 行全为被 wt 重构取代旧行→直复制；index.ts 九锚移植（maintenance import 并入、plan-renewals import、billingCreditWriter 提升、renewals grantor 装配、creditWriter 共享、renewalSweeps 启动 key=4_192_007、billingProjectionStore+stampSubscriptionOwnership 接线+readSubscriptions 复用），保留 #227 catalog-sync/#259 unknown-mark/#222 database 传参全部 main 侧内容；audit.ts/app.ts/routes.ts 核实无 #292 增量（main-only=已集成词条，wt-only=注释标点/旧注释）跳过。
- 迁移重编号落地：0134_subscription_owner_allowance→0142（snapshot 复制重命名+journal append，143 条）。
- 集成库回归 @5594 openbot_b5_292i（143 迁移+roles）：subscription-ownership 7+plan-renewal-grantor 3+billing-store 14=24 pass、payment-callback-ownership 4+billing-reconcile 28=32 pass、tsc 0。
- 运行中：#228（ctx_2f7479ac3216 第三任）、review-244（第二任已 succeeded 双 PASS 待集成）、#244 集成（0143）排队。
- 下一波：#293（10.4）已解锁待派。
- review-259 双 PASS（Spec 4/4+质量 A-，3 Low+5 Info 无 Medium+；unknown 不超时回收突变复证成立）——#259 已集成无需返工。
- review-244 第三任双 PASS（Spec 4/4+质量 A-，3 LOW+2 INFO；4 突变复证 M1-M4 全红）。
- #244（05.3 每授权独立 Key 签发）集成完成（第 55 张）：直复制 key-issuance.ts/key-issuance.integration.test.ts/schema-gateway.ts（91 行）/audit.ts（12 行词条）/bot-services-auth.ts；app.ts 两块（05.3 注释改写+keys 条件传递行）+registry.ts 四步（import/接口声明/modelAccess 提升 const/keys 装配）；index.ts/credit-reserve.ts 的 wt-only 全为旧基线形态零增量不动；迁移 0140_gateway_virtual_keys→0143（journal append 时 when 沿用原值触发严格递增断言红，改 0142.when+1000 后过——**重编号 when 必须取前一条+1000，不能沿用 worktree 原值**）。
- 集成库回归 @5594 openbot_b5_244i（144 迁移+roles）：key-issuance 5/5、bot-service-auth+binding-codes+service-credentials 12、registry 集成+binding-issuance+hardening 27，全绿 tsc 0。
- 运行中：#228（ctx_2f7479ac3216 探活确认在读 credit-reserve 5-7 步）。
- 静默卡死第 15/16 次事件：#228 第五任（2.6h 零文件写）/#245 第三任（53min 零写）md5 双轮对比确认冻结（宿主 load 已降 11.4，非过载）。abandon+ready+重启：#228 第六任 ctx_1720f7a2ab25、#245 第四任 ctx_998463aa4834，接续简报附产出清单。
- review-293 运行规范（主动 heartbeat alive/investigating）。
- 运行中 3：#228（ctx_1720f7a2ab25）、#245（ctx_998463aa4834）、review-293（ctx_2f5c07069374）。

## T109（2026-10-18）
- 「冻结」误判纠正：#228 第六任/#245 第四任实为长收尾，随后三 worker（含 review-293）全部 [succeeded/root_completion]。教训：md5 双轮相同+文件久无写入不足以定性冻结，须再核 worker-list 状态（[succeeded] 一票否决冻结判读）。
- review-293 双 PASS（Spec 4/4+质量 A：7 突变全灭/61 用例独立复跑/52 文件哈希零漂移/幂等键 DB 唯一索引兜底实证）。
- #293（10.4 签到奖励进个人账户）集成完成（第 56 张）：直复制 routes.ts（wt=80 main=0）+audit.ts（8）+app.ts（18/1：createBillingCreditRoutes 展开条件装配）+rewards.ts+checkin-rewards.integration.test.ts 两新增。主仓库 tsc 11 错全在用户工作区无关实验文件（kb/bun-compat/desktop-telemetry），billing/audit/app 零涉及；集成面回归改在 worktree 跑（用户 01:56 提交 bced6121 把 912 套件迁 tester-army，test-preload mock.module 破坏旧 bun test 路径，主 HEAD 演进至 bced6121）：checkin-rewards 11/11 单跑+回归 5 文件 50/50=61 全绿。bun test 多文件合跑吞文件坑再现（6 文件只跑 5），单跑补验。
- #228 完成（第六任）：catalog-freshness.ts 门禁+credit-reserve 准入集成+21 用例+票面 checkpoint；产出经 Orca 自动 checkpoint commit 保留（26934386+3b775b03）。coordinator 复验 @5594 openbot_b5_228c：21/21+reserve-revalidation 27/27（首跑 1 例瞬时抖动重跑即绿）。
- #245 完成（第四任）：credential-bundle.ts+key-issuance.ts bundle 装配+gatewayKeyStatusView+8+5 用例；产出在 2b3b07b2+caa66683。复验 @5594 openbot_b5_245c：8/8+5/5+tsc 0。
- 双 review 派发：review-228（task_fa15811a693a，ctx_539401ad5412）、review-245（task_18dcbbdebd12，ctx_fd48ef18dd9c），报告路径均钉死主仓库 reviews/。
- 运行中 2：review-228、review-245。

## T110（2026-10-18）
- review-228 双 PASS（Spec 4/4+质量 A：#259 交互+0140 协同核验、21+27 独立复现、突变约束真实；遗留 F-OBS1 生产装配时点=下游票边界+F-OBS2 风格）。
- review-245 双 PASS（Spec 4/4+质量 A：明文泄露面全链路审计+5 突变；F1 票面计划文档哈希滞后低危/F2 拒绝码命名漂移记录项/F3 expiresAt 恒 null 归属后续票 Q13/F4 双处明文=同答同通道刻意行为）。
- #228（03.6 新鲜度门禁）集成完成（第 57 张）：**形态迁移**——主仓库 credit-reserve.ts 已有 03.6 前身内联实现（直读 gatewayCatalogSyncState+ageMs 比较，来自 #227 集成时代），本票替换为独立 gate 模块形态：catalog-freshness.ts（新，唯一权威含 DEFAULT 常量与 recordSyncSuccess）+credit-reserve 四步替换（删本地 DEFAULT export/删 sync-state 直读依赖/Environment 注释换 gate 措辞/第 5 步内联块→assertCatalogFresh 调用）+21 用例测试；index.ts 经方向统计零增量不动。
- #245（05.4 CredentialBundle 明文边界）集成完成（第 58 张）：credential-bundle.ts（新）+key-issuance.ts（289 行 bundle 装配层）+registry.ts（16 行 keys 深化）+两测试直复制（主仓库侧文件自 #244 集成后零演进）。
- 集成回归环境受阻处置：主仓库 test-preload（用户 bced6121 tester-army 迁移，mock.module 需新 bun）破坏旧 bun test 路径且 --config 覆盖不生效；改为已释放的 b5-245 worktree 叠加主仓库全部未提交集成层（#293+#228+#245）跑六套：catalog-freshness 21+reserve-revalidation 27+credential-bundle 8+key-issuance 5+bot-service-registry 10+checkin-rewards 11=82 用例 0 fail，三层共存验证通过。
- 运行中 1：#294（ctx_09a29641552f）。
- 波次派发：#246（05.5 期限，task_80193a61685d，ctx_8611fd4bd18e，worktree 基线=HEAD+全部未提交集成层+tsc 0）、#269（07.6 输入计数，task_ce90f417aaeb，ctx_fdeb89e50822，governance 基线 16s ok）。#249 暂不与 #246 并行（同 key-issuance.ts 写面冲突）。
- 运行中 3：#294（ctx_09a29641552f）、#246（ctx_8611fd4bd18e）、#269（ctx_fdeb89e50822）。
- #294（10.5 套餐积分进个人账户）完成并闭环前半：7 文件 8.1KB（payments/service.ts 购买归属+credits-writer+plan-renewals+reconcile 等，checkpoint 哈希在报告）。coordinator 复验 @5594 openbot_b5_294c：plan-credits-personal 4/4+#292 面回归 42 用例（plan-renewal-grantor 3+subscription-ownership 7+payment-callback-ownership 4+billing-reconcile 28）全绿。**⚠️ worker 披露环境事故**：首次 migrate 误读 .env DATABASE_URL 向 live 开发库 localhost:55432/openbot 应用 3 条基线迁移（0141/0142/0143=主仓库已提交层内容，非本票迁移，前向 DDL 无数据破坏，用户下次 db:migrate 本会应用同批）——待向用户汇报；后续简报已统一禁 5432/5435/55432。review-294 派发（task_7d98b15173e3，ctx_033818a1c0bc）。
- 运行中 3：#246（ctx_8611fd4bd18e）、#269（ctx_fdeb89e50822）、review-294（ctx_033818a1c0bc）。
- review-294 双 PASS（Spec 4/4+质量 A-：M-A 收款账户改部署键/M-B 幂等键随机两突变各杀 4/4；净增量实测校准=新测试 30.7KB+票面 Checkpoint 行，生产代码零改动——归属接线 #292 已交付，本票以集成测试+变异验证证明契约；#246 简报口径 8.1KB 为 checkpoint 统计差已记录）。
- #294（10.5 套餐积分进个人账户）集成完成（第 59 张）：plan-credits-personal.integration.test.ts 4/4（叠加环境回归）+票面 Checkpoint 行；组 10 个人购买与奖励全链（10.1-10.5）至此闭环。
- #246（05.5 期限）完成复验：key-expiry 17（新）+key-issuance 5+credential-bundle 8 全绿 @5594 openbot_b5_246c；Go 侧零改动披露正当（上游 IsExpiredAt 闸门自带，本机 go1.26.3<1.27 拉不动工具链——worker 环境限制，coordinator 侧 1.27 工具链复验在 review 简报钉死）。
- #269（07.6 输入计数）完成复验：vet clean+BoundEvidence 10/10+全量 16.3s ok。
- 双 review 派发：review-246（task_d8d6d49a3ad5，ctx_0d659205f7e5）、review-269（task_01ef88657136，ctx_0b12a4b27d16）。
- 运行中 2：review-246、review-269。
- review-269 双 PASS（Spec 4/4+质量 A-：M1 计数跳过工具/M5 无上限默认 4096 两突变击杀；json.Marshal 完整请求+ExtraParams 求和、marshal 失败 MaxInt64 fail-closed、cap_not_provable 门零调用）。
- #269（07.6 完整序列化输入计数）集成完成（第 60 张）：governance 7 文件（boundevidence.go 新+creditadmission/main/resolver 接线+3 测试扩展）直复制+票面；集成复验 vet clean+全量 16.1s ok。
- #249（05.8 Key 状态同步）完成复验：key-state-sync 9（新）+key-issuance 5+credential-bundle 8 全绿 @5594 openbot_b5_249c（checkpoint 21 文件 48KB）。review-249 派发（task_99ce702c8988，ctx_1bf3ca254c38）。
- review-246 核查项已全 ✅（两层 fail-closed/M1/M3/M6 突变、Go IsExpiredAt 逐位一致+上游拒绝链实证），质量档位汇总待 worker 收尾。
- 运行中 3：review-246（ctx_0d659205f7e5）、review-249（ctx_1bf3ca254c38）。

## T111（2026-10-18）
- review-246 双 PASS（Spec 4/4+质量 A：两层 fail-closed 拒 boot/拒合成、M1/M3/M6 突变、Go IsExpiredAt 逐位一致+上游拒绝链 store.go:1505→permit.go:193→main.go:951 实证、EXPIRY IS A VERDICT NOT AN ERASER 语义）。
- #246（05.5 期限）集成完成（第 61 张）：key-expiry.ts（新）+key-issuance.ts（56 行期限实现，main-only 5 行旧形态被超集重构）+gateway schema 注释更新+两测试；集成回归 key-expiry 17+key-issuance 5+credential-bundle 8 全绿。
- review-249 双 PASS（Spec 4/4+质量 A：单向/零创建/last-good 三不变量三层证据、22/22 独立复跑、前置 14 文件零触碰接线缺口如实上报）+F1 Medium 集成必办（调度器零引用休眠）。
- #249（05.8 Key 状态同步）集成完成（第 62 张，含 F1+F2）：4 新文件直复制（key-state-sync.ts+测试+0144 SQL/snapshot，journal 145 条）+schema gateway.ts 两表锚点插入（gatewayKeySyncState/Drift）+F1 两处接线（index.ts 调度器组装 createGatewayVirtualKeyStateClient+signal stop；admin-routes POST /keys/sync+gateway.key_state_sync_triggered 审计词条）+F2 setTimeout clearTimeout finally 修。集成回归 @5594 openbot_b5_249i（145 迁移）：key-state-sync 9+key-issuance 5+key-expiry 17+credential-bundle 8=39 用例全绿 tsc 0。
- 组 05 全链（05.1-05.8）至此闭环。
- 运行中 0；下一波可派：#257（06.6）、#260（06.9）、#295+（10.6 展示）、07.7+。
- 新一波三域派发（域分离零重叠）：#270（07.7 provider 输出封顶，task_5c617307becc，ctx_17eb0459aac3，governance 基线 15.6s ok）、#257（06.6 尾差累计，task_3e7688e03a02，ctx_042f8c7412df，tsc 0）、#295（10.6 订单/Grant 追溯 UI，task_fee6501b5345，ctx_1f35e537dc12，app 生成产物 application-config.ts 需手工复制——worktree create 不带 gitignored 生成文件）。#260 与 #257 同域排队。剩余未做票核验：04.6/04.7/05.9/06.6/06.9/07.7/10.6/21.5 等（checkpoint 全空；#210/#239/#240 待考古甄别是否早期已交付）。
- 运行中 3：#270、#257、#295。
- #270（07.7 provider 输出封顶强制）完成复验：vet clean+OutputCap ok+全量 16.4s ok（checkpoint 26 文件 59.5KB）→review-270 派发（task_4c72d4ff2a94，ctx_7aff5b518976）。
- #257（06.6 每账户尾差累计）完成复验：credit-remainder 5+billing-credits-writer 16 全绿 @5594 openbot_b5_257c（checkpoint 26 文件 59.6KB）→review-257 派发（task_5cf243a40af8，ctx_512c19e4ed32）。
- 运行中 3：#295（ctx_1f35e537dc12）、review-270、review-257。
- review-270 双 PASS（Spec 4/4+质量 A-：突变 5/5 killed、AC2 拒绝消息原样携带 Detail/Environment 区分「无法验证/验证不强制」、cap_not_provable 复用 07.6 词表；遗留=真实供应商验证记录为零属 22.3 conformance 输入缺口 fail-closed 正确）。
- #270（07.7 provider 输出封顶强制）集成完成（第 63 张）：governance 8 文件（outputcapevidence.go 新+creditadmission/main 接线+5 测试扩展）——首 cp 循环管道故障 diff 仍 8 处，重直白 cp 后 diff 0+vet clean+全量 16.3s ok。
- review-257 双 PASS（Spec 4/4+质量 A：四突变全敏感含 MUT-D 证 AC-4 准入语义此前零覆盖；叉乘精确有理数断言、生产同款开户无旁路；净增量=测试-only，生产机制 capacity owedUnit/settle 尾差 UPSERT 早已在库）。
- #257（06.6 每账户尾差累计）集成完成（第 64 张）：credit-remainder.integration.test.ts 5 用例+票面；生产文件零增量（wt=0 核实）；叠加环境回归 5/5 绿。
- 运行中 1：#295（ctx_1f35e537dc12，UI 实现中 trace.ts 已产出）。
- 静默卡死（#295 第一任）：57 分钟零文件写+md5 双轮同——abandon+ready+第二任 ctx_f5f2d1ff94f9+接续简报（trace.ts+RED 测试清单）。
- 运行中 1：#295（ctx_f5f2d1ff94f9 第二任）。
- #295（10.6 个人订单与 Grant 追溯页面）完成并闭环前半（第二任）：app 域 35 文件 76.4KB（trace.ts+orders 页面+8 UI 测试+locales+routeTree 再生成）。coordinator 复验：UI 8/8+app tsc 0。review-295 派发（task_cc0f6ffb8866，ctx_44e551390323）。
- 运行中 1：review-295。
- review-295 双 PASS（Spec 4/4+质量 A-：M-A 猜测守卫/M-B URL 审计注入/M-C refresh 漏取/M-D 空态妆饰四突变全红；trace.ts 正则与生产 reason 句式逐字核验、refuses-to-guess 对离格 reason 绝不猜测；SOURCE_LABELS satisfies 编译期漏译防护）。
- #295（10.6 个人订单与 Grant 追溯页面）集成完成（第 65 张）：9 文件直复制（orders-view.tsx/orders.tsx/trace.ts/credit-grant-list.tsx 超集重构/settings-sidebar 入口/en+zh locales 33+33/routeTree.gen/UI 测试）；主仓库 app tsc 2 错=用户实验文件（linked-notice.test）本票零涉及；UI 8/8 绿。**组 10 个人购买与奖励全链（10.1-10.6）闭环**。
- 运行中 0。剩余主链：06.9（#260）、07.7 后 governance 链（07.8+）、04.6/04.7/05.9/21.5、#210/#239/#240 考古。
- 剩余全量盘点：88 张待做（此前累计 65 计数低于 151 总数——DAG 深链 07.8+/08+/09+/11-20 组+21-22 终局远未走完）；考古确认 #210（conversion-rate rateVersion）/#239（authorization-impersonation 13 用例）/#240（access-grant-revoke）均已有交付痕迹（早期已交付票面 checkpoint 未填）。#260（06.9 Settle 幂等）=关键路径瓶颈（解锁 261/262/263/271→07.8-07.12→08 全链→09→11-20→21-22）。
- 新一波三票派发：#260（task_a4187269f979，ctx_5e1cbd5b8073）、#247（task_9016b70ebeba，ctx_4e7b0b6528be）、#213（task_8466001f6cc3，ctx_c7f53486b29f），三 worktree 基线=HEAD+全部未提交集成层+bifrost rsync+app 生成产物。
- 运行中 3：#260、#247、#213。
- #260（06.9 Settle 幂等，关键路径）完成复验：settle-idempotency 29（新）+credits-writer 16+remainder 5+unknown-hold 7=57 用例全绿 @5594 openbot_b5_260c（checkpoint 37 文件 96.4KB）→review-260 派发。
- #213 429 速率限制自愈（plan 文档已产出）；#247 读阶段推进中。
- 运行中 3：#247、#213、review-260。
- review-260 双 PASS（Spec 4/4+质量 A−：五突变 4 捕获、M3 存活定性为纯测试覆盖缺口——探针实证锁定比例生产行为正确，建议随 #261/#256 顺带补一例；29+16+5+7=57 独立复跑全绿；06.10 边界未越）。
- #260（06.9 Settle 幂等，关键路径）集成完成（第 66 张）：credit-settle.ts（新）+settle-idempotency.integration.test.ts（29 用例）+票面三件直复制（hash 核对一致）；集成回归 @5594 openbot_b5_int260 四套件 e2e 运行器（见下）。解锁 #261（06.10）/262/263/271 下游链。
- 测试基建认知更新：用户 bced6121 后 bun test 全仓路径死（test-preload 从 e2e-compat 借 mock 而后者无 mock.module，bun 1.4.2）——新正道=tester-army e2e 运行器：./node_modules/.bin/e2e run --config e2e.unit.config.ts <文件参数收窄>；主仓库可直接跑（node_modules 齐）。两 e2e 套件均 import tests/support/e2e-compat（repo 根 tests/ 目录，worktree 同步清单须含根 tests/，此前只抓 server|app 前缀）。
- review-247 派发（task_04dd81ca99e6，ctx_4b944ada533a，5594 全新库复验）。
- #213 worktree 重建（b5-213r）：旧 b5-213 基线烂（缺 76 文件+版本错配）放弃修补；发现 #213 三件+app.ts 装配块已在主仓库未提交层（readiness.ts 与救出件 SAME；app.ts 与旧 worktree 逐字一致；两测试已被适配 e2e-compat import——bun:test→tests/support/e2e-compat）——重建目的收窄为复验+review。b5-213r 建立时 inherit 误继承平行历史 bbea87ba（用户 e2e 迁移线），reset --hard 3e8a6072 纠正（bbea87ba 仍被 b5-213-2/b5-246 分支引用，无损）。
- 运行中 3：review-247、#213 复验（e2e 后台）、#260 集成回归（e2e 后台）。

## T113（2026-10-18）
- #247（05.6 密钥续期）集成完成（第 67 张）：review-247 双 PASS（Spec 4/4+质量 A−：复核式轮换/明文纪律/fail-closed、探针 27/27、基线两既有失败归因核实）后 checkpoint 247 五件 hash 全对齐直复制（key-renewal.ts 新+key-issuance.ts renew 路由+registry.ts 装配+audit.ts 词条+8 用例测试）。
- 集成回归八文件 104/104 全绿 @b5-245 常设叠加环境 bun test（gate 20+integration 14=renew 8+issuance 5=settle 29+writer 16+remainder 5+unknown 7）；#260（第 66 张）/#247/#213 三票集成回归一并完成。
- #213 复验修正：gate 盘点用例唯一红=后续票（06.x reserve-bound 的 createConversionRateStore/#244 registry 的 gatewayEndpointControls/#249 index.ts 接线）正当装配被模式误伤——coordinator 裁决加 ALLOWED_ASSEMBLY_SITES 具名豁免（每条注明票源），主仓库 e2e-compat 版+b5-245 bun:test 版同步重打，34/34 绿。
- 测试基建实况修正：主仓库（3e8a6072 提交层）bun test 死（preload e2e-compat mock 无 module）且 e2e node target 跑不了 integration（db/client.ts import "bun" 模块解析崩）——bun-compat 只装 globalThis.Bun 不拦截模块。**工作区适配法**：test-preload.ts 的 mock import 换回 bun:test 一行（语义同），bun test 全恢复（b5-213r 29/29 实证）；已入新 worktree 标准基线第 5 步。e2e 运行器并发+残留 .e2e 目录会卡死（0% CPU 挂起），串行+清目录后正常。
- review-247 遗留一行缝合（coordinator 办）：credential-bundle-boundary.test.ts issuerFor 补 keyTtlMinutes: 15（05.5 TTL 必填后 05.4 harness 未跟上），8/8 绿。
- 新一波三路派发（域分离零重叠）：review-213（task_c6e589624adf，ctx_1d7910fac9ee，b5-213r 只读）；#261（06.10 Settle 冲突+Grant 中途过期，task_7b75f2d8e886，ctx_2d638be7feaa，b5-261，简报附 review-260 发现#1 顺带项）；#271（07.8 PostLLM 结算+result outbox，task_71571622a76f，ctx_aae7d83f4910，b5-271，governance 冒烟 16s ok）。两新 worktree 均建后 reset 3e8a6072+五步基线（tsc 10=基线、bun test 29/29 冒烟绿）。
- 旧 #213 实现 worker（ctx_c7f53486b29f）stop+completed（产出已收）。#271 集成后解锁 07.9/07.10/08.1/09.1。
- 运行中 3：review-213、#261、#271。
- review-213 双 PASS（Spec 4/4+质量 0高/0中/1低/4提示：fail-closed 行为级证明、脱敏结构性、01.6 作废规则复用单点维护、清单测试防漂移；Low#1=endpoint 读失败双原因聚合误导展示+*_unavailable 分支无单测——fail-closed 不受影响，留档转下游消费提示，交接注记三条：blockingReasons 唯一事实源/configVersion 与 rateVersion 配合/读失败场景句子不可信）。
- #213（01.7 消费入口就绪门禁）集成完成（第 68 张）：产出先前已在主仓库未提交层（readiness.ts+app.ts 装配块+两测试），本段补齐复验 34/34（豁免修正后）+集成回归（b5-245 八文件 104/104 含它）+review 双 PASS。组 01 主链至此（01.1-01.8 全闭环）。
- 运行中 2：#261、#271。
- #261（06.10 Settle 冲突+Grant 中途过期）完成复验：settle-conflict-grant-expiry 7（三类冲突码 conflictKind 稳定+中途过期两例+释放后过期即死+review-260 发现#1 顺带锁定非零 rateVersion 正向 6000 例）+settle 29+remainder 5=41/41 绿 @5594 openbot_b5_261c 全新库；报告完备（TDD 轨迹+stash 实证 typecheck 失败为 HEAD 既有 e2e 迁移债）。→review-261 派发（task_74fcdea15377，ctx_8834767352a1）。
- #271（07.8 PostLLM 结算+result outbox）完成：worker succeeded 但报告/票面 Checkpoint 未写即终——coordinator 验产出健康（governance 全量 ok 15.1s+vet 0+TS usage-outbox 6/6 @5594 openbot_b5_271c）后代记账（报告+票面 Checkpoint 填 hash 清单），AC 覆盖独立判定转交 reviewer。净增量：settlementoutbox.go（29.5KB 新）+测试（25.4KB）+creditadmission/main 接线+TS 6 用例。→review-271 派发（task_508b7ae3a55b，ctx_371888cba765，简报注明 bifrost gitdir 指针坑：worktree bifrost 内 git diff 不可信用文件级 diff）。
- 坑记录：worktree bifrost/.git 的 gitdir 指针（指向主仓库 modules/bifrost）使 git 视角锚到主仓库 bifrost 工作树——worktree bifrost 内 git status/diff/log 均反映主仓库状态，settlementoutbox.go 因此「不可见」。此前各 Go 域票集成用文件级 cp 未受影响；后续 review 简报统一提示。
- 运行中 2：review-261、review-271。
- 新一波三票派发（域分离零重叠）：#214（01.8 管理员就绪状态页面，task_0950f1f14cc9，ctx_5ab697318793，b5-214-2，简报含 review-213 交接注记）、#250（05.9 归属漂移处置，task_c88c9f369739，ctx_b238f14c1edf，b5-250）、#263（06.12 用户视图，task_a2394a0c07f1，ctx_0b45ba6f6f75，b5-263，简报注明勿依赖未集成的 #261 conflictKind）。三 worktree 五步基线齐（tsc 10=基线）。#262 等 261 集成（同域 credits-writer）；#268 排后（governance 撞 271 增量）；#238/#349 下一波候选。真就绪待办扫描（行内含集成完成的宽松匹配+tickets.json blockedBy）：9 张（211/214/238/250/262/263/268/271/349），已集成 52 计数。
- 运行中 5：review-261、review-271、#214、#250、#263。
- #263（06.12 用户视图）完成复验：credit-views 13（pending 真实化+归因表 0145+重放幂等自查修复）+settle 29+remainder 5=47/47 绿 @5594 openbot_b5_263c 全新库（migrate 含 0145）；报告完备（AC 4/4+RED 缺陷自查+UI 8/8）。→review-263 派发（task_c74cf43edf57，ctx_7bc94e752076，六焦点含既有 e2e-compat 套件更新仅契约适配的核验）。
- 运行中 4：review-261、review-271、#214、#250、review-263（计 5）。
- #214（01.8 管理员就绪状态页面）完成（交接验证轮形态：实现本体（服务路由+页面+13 测试）已随主仓库 HEAD checkpoint 存在，本轮修复 bced6121 迁移对两测试文件的 import 破坏（各 1 行回 bun:test）+全量重验）：server 9+app 4=13/13 绿 @5594 openbot_b5_214v；app build exit 0；报告含 typecheck 仓库级 WIP 债的精确归因（532 个 e2e-compat 套件双 runner 均堵，无一错误触及本票文件或生产 src）。→review-214 派发（task_d09c9e19455c，ctx_5c3c97b16e73）。
- #250（05.9 归属漂移处置与手工 Key 不接管）完成复验：key-drift-handling 10（三漂移最小字段集+暂停发放/续期+手工 Key 零接管+处置面）+sync 9+expiry 17+renewal 8+issuance 5=49/49 绿 @5594 openbot_b5_250c（迁移 0145 drift_events 表）。→review-250 派发（task_d8693f86de14，ctx_aa45780e21ff）。
- 仓库级发现（214 报告精确归因，转用户）：bced6121 迁移后 532 个 server 套件 e2e-compat import 双 runner 均堵（bun test→CollectionError；e2e/node→import 'bun' 崩），ADR-0008 运行时缺口；本工作区以 test-preload 一行回 bun:test 的适配恢复 bun test 全量可用。
- 运行中 5：review-261、review-271、review-263、review-214、review-250。
- review-214 双 PASS（Spec 4/4+质量 0高/1中/3低：F1 中=admin-sidebar 与 index 不同步跨票回归（#234 botServices+#214 gateway+#223 modelCatalog 三入口缺）——reviewer 裁定不阻塞 #214，coordinator 集成缝合办掉：sidebar reach 组按 index 顺序补三入口（IconRobot/IconNetwork/IconServer）+en/zh-CN admin.json sidebar 三键；缝合后 4/4+tsc 干净。
- #214（01.8 管理员就绪状态页面）集成完成（第 69 张）：实现本体已在主仓库 HEAD checkpoint 层（服务路由+页面+13 测试），本段 delta=两测试文件 bun:test import 修复（bced6121 破坏）+F1 sidebar 三入口+locales——五件 cp 主仓库；集成回归 @b5-245：gateway-admin-routes 9+key-issuance 5+readiness-gate 20=34/34 绿。**组 01（01.1-01.8）全链闭环**。
- review-263 双 PASS（Spec 4/4+质量 A−：六焦点全成立——语义同源探针 P1 六形态恒等/writer 零改动三层证据/5 路并发重放归因恰 1 行/stranger SQL 级零跨账户 pairing/既有测试逐 diff 净增不弱化；1 Low=超持钳制 consumed=Σcharged 无套件级钉子（探针 P2 已证生产行为正确，mutation M3 存活仅覆盖缺口）；3 Info=占用谓词双写/双 consumed 语义文档化/陈旧文案）。
- #263（06.12 预留/待结算/实扣接入用户视图）集成完成（第 70 张）：16 件直复制（0145_credit_reservation_attribution 迁移 146 条 journal+schema credit-reservations+credit-reserve 协议层归因同事务+credits.ts pendingSettlementOf 聚合+types/routes UI 四件+locales+credit-views 13 用例+read 10 用例升级）；集成回归 @b5-245：credit-views 13+personal-credits-ui 8+personal-credits-read 10=31/31 绿（read 在叠加环境做 bun:test runner 适配一行）。#263 迁移占 0145 号——#250 集成时 drift_events 须改号 0146+when+1000。
- 运行中 3：review-261、review-271、review-250。
- review-250 双 PASS（Spec 4/4+质量 PASS 两条 minor：dispose audit 写入时机注释不符（幽灵窗口极窄）/05.8 sweep 未覆盖新表（共享库卫生），均不返工）。
- #250（05.9 归属漂移处置与手工 Key 不接管）集成完成（第 71 张）：13 件 cp+**迁移改号 0145→0146**（tag 形态核对修正+when=0145+1000，journal 147 条，openbot_b5_int250 全新库 migrate ok 实证）；净增量=key-drift.ts（新：三类漂移最小字段集+暂停发放/续期+手工 Key 零接管结构性保证）+drift_events 迁移+schema gateway.ts+audit 词条+admin-routes 处置面+key-issuance/renewal 暂停检查+key-state-sync 折叠比较+index 接线+10 用例；credit-reserve.ts 因 263 后集成演进差异跳过（250 版为无归因旧形态，功能不涉本票）。集成回归 @b5-245：drift 10+sync 9+expiry 17+renewal 8+issuance 5+admin-routes 9=58/58 绿。**组 05（05.1-05.9）全链闭环**。
- 运行中 2：review-261、review-271。
- 新一波两票派发：#238（04.5 登录确认并创建模型访问授权，task_c128edaa9ff7，ctx_deeee1e2f7c9，b5-238-2）、#349（21.5 在途检查与不删除约束，task_36e5c29ace85，ctx_8f67908d439d，b5-349）。两 worktree 基线=最新集成层（0146 迁移链，61 文件）；首建同步曾误用 worktree 自身 status 清单（2 文件），改主仓库清单重同步修正。简报注明迁移号从 0147 起。
- 运行中 4：review-261、review-271、#238、#349。
- review-261/review-271 双卡死判定与重派：两任 2 小时零报告落盘+/tmp 副本 07:06 后 1.5h 无文件活动+md5 双轮同+worker-list 非 succeeded——按纪律 abandon+task ready+第二任接续（ctx_b2c829ad441e/ctx_5e9750d155d0，简报附前任环境清单：/tmp/b5-261-root、/tmp/b5271-base 副本与复验库可复用省搭建）。
- 运行中 4：review-261（二任）、review-271（二任）、#238、#349。
- #238（04.5 登录确认并创建模型访问授权）完成（核验收口形态：交付物已在基线 a18e2711——access-grants 服务+0127/0131 迁移+确认页+13 用例；本票=1 行 runner 适配+全新库证据）：access-grant 13/13 绿 @5594 openbot_b5_238v。→review-238 派发（task_5dab00102e9c，ctx_9e00e2708476）。
- #349（21.5 在途检查与不删除约束）完成复验：cleanup-guards 11/11 绿 @5594 openbot_b5_349c（四道硬墙+新鲜在途探针+无迁移纯程序层；谓词灵敏度自验：退回 reserved-only 5 测红）。→review-349 派发（task_774c64a05f06，ctx_83cbafbac965）。
- 运行中 4：review-261（二任）、review-271（二任）、review-238、review-349。
- review-261 二任双 PASS（Spec+质量均 PASS：三组突变全杀且失败面精确、四 AC 证明强度高、Q24 双向钉死、锁定非零费率 6000 例实测；F1=settle 面生产装配未挂 app.ts 属后续接线票；F2/F3=HEAD 既有 e2e 迁移债，文件集交集判定零本票引入）。
- #261（06.10 Settle 冲突+Grant 中途过期）集成完成（第 72 张）：三件 cp（credits-writer.ts conflictKind 三抛点+credit-settle.ts detail.kind+7 用例）+票面；集成回归 @b5-245 @openbot_b5_int250：settle-conflict 7+settle 29+remainder 5+unknown 7+views 13=61/61 绿。**组 06（06.1-06.12）全链闭环**。F1（settle 面 app.ts 接线）+review-263 Low（超持钳制用例）留档为后续接线票输入。
- review-238 双 PASS（Spec 4/4+质量 0阻塞/0高/0中，3 Low+4 Info 打磨项）。
- #238（04.5 登录确认并创建模型访问授权）集成完成（第 73 张，核验收口形态）：净增量 1 件（access-grant.integration.test.ts 一行 runner 适配 bun:test），13/13 绿 @b5-245 集成环境。组 04 至 04.5 闭环（04.6=#239/04.7=#240 待考古收口）。
- 勘误：前条"组 06 全链闭环"应为"06.10 终点票闭环"——#262（06.11）仍未做，组 06 尚差 06.11。
- 下一波派发：#262（06.11，261 已集成解锁）。
- #262（06.11）派发（task_7bca285e973d，ctx_daa0a4eecd92，b5-262 全量同步修正后 tsc 10=基线）。运行中 3：review-271（二任）、review-349、#262。
- review-349 双 PASS（Spec 4/4+Standards 0 硬违规 4 判断项：突变验证 reserved-only 退回恰 5 红灵敏度成立、08.1 缺位诚实记录、写域零越界；移交 N1"最后一道门"契约给 21.6）。
- #349（21.5 在途检查与不删除约束）集成完成（第 74 张）：五件 cp（cleanup-guards.ts 新+classification/relations 修改+11 用例+plan）；credit-settle.ts 因 261 后集成演进差异跳过（349 版为无 conflictKind 旧形态，功能不涉本票）。集成回归 @b5-245：cleanup-guards 11+unknown-hold 7+settle-conflict 7=25/25 绿。
- 运行中 2：review-271（二任）、#262。
- review-271 二任同模式卡死（70 分钟零产出+/tmp 静默+负载正常）——疑似 b5-271 worktree 的 bifrost gitdir 坑致 git 锁竞争。处置：新组装干净 worktree b5-271r（bifrost 从 b5-271 rsync+净增量叠加+双冒烟 ok）+三任派发（ctx_7be0fac52d31，简报明令 bifrost 内禁 git 命令+先写报告骨架再填证据）。
- 运行中 2：review-271（三任）、#262。
- review-271 三任双 PASS（干净 worktree+骨架先行策略生效，5 分钟出报告：Spec 4/4+质量 PASS 全 info；Go 全量 15.7s+race 43.1s+vet 干净；四 AC 结构证据——持久化先于响应（阻塞 door 零 sleep）/投递失败四路收敛不丢失/字段覆盖恢复所需/LOCKED basis 独立复算 267/20 吻合；F4 核实 e2e-compat clearTimeout copy-paste 前置缺陷建议小票修）。
- #271（07.8 PostLLM 结算+result outbox）集成完成（第 75 张）：governance 4 件 cp（settlementoutbox.go+测试新+creditadmission/main 接线）+TS 5 件（usage-outbox 6 用例+plan+票面+报告）；主仓库 Go 全量 16.4s ok+vet 0；集成回归 @b5-245：outbox 6+settle 29+conflict 7=42/42 绿。**解锁 07.9（#272）/07.10（#273）/08.1（#276）/09.1（#286）**。
- 运行中 1：#262。
- 新一波两票派发：#272（07.9 重复 ack 只记录一次，task_cb7d4a1a7f07，ctx_dbfdc92df1b0，b5-272，Outbox 冒烟 ok）、#286（09.1 工作台改走网关，task_eb062ab10f6c，ctx_e1137af0dd64，b5-286）。#273/#276 排下一波（避免与 272 撞 settlementoutbox/驱动器文件）。
- 运行中 3：#262、#272、#286。
- #262（06.11 Release 需确认未计费与过期额度不复活）完成复验：release-semantics 24（证据封闭集+四态判定+幂等 released+settle×release 并发锁序钉死；自查发现并修正死锁序设计）+settle-conflict 7=31/31 绿 @5594 openbot_b5_262c。→review-262 派发（task_cd79716de292，ctx_eabf19132a2a，骨架先行）。
- 运行中 3：#272、#286、review-262。
- review-262 双 PASS（静态五焦点咬合+动态自建库 24/24×3+回归 29/7/5+三项突变探针差分+哈希逐一相符；装配缺口归 review-261 F1 跟踪——settle/release 面 app.ts 挂载是同一后续接线项）。
- #262（06.11 Release 语义）集成完成（第 76 张）：五件 cp（credit-release.ts 新+credits-writer 一行+24 用例+plan+票面）；集成回归 @b5-245：release 24+settle 29+conflict 7+unknown 7=67/67 绿。**组 06（06.1-06.12）全链真正闭环**。留档：settle/release 协议面生产装配（app.ts 挂载）待后续接线票（review-261 F1）。
- 运行中 2：#272、#286。
- #272 卡死判定与二任：worktree 35+ 分钟零活动+/tmp 零+消息戳 8 分钟无响应——abandon+二任（ctx_36fd2a77e739，简报附前任部分产出：settlementoutbox.go +123 行 ack 实现+测试 +86 行，要求先核实再补齐+骨架先行）。
- 运行中 2：#272（二任）、#286。
- #272（07.9 重复 ack 只记录一次）二任完成复验：governance 全量 17.0s ok+vet 0（接续前任部分产出核实+TDD 收尾；四 AC：三次投递一次扣费/丢 ack 重投收敛/DuplicateEvents 计数/重复 ack 不改终态）。→review-272 派发（task_a476ee389729，ctx_c5ab3bbee005）。
- #286（09.1 工作台改走网关）完成复验：workbench-gateway-routing 7/7 绿 @5594 openbot_b5_286c（setWorkbenchGatewayModel seam 三级权威+fail-closed+无计费分支字节不变+attribution 归因）。→review-286 派发（task_8786d77b1076，ctx_5ab4ccabe599）。
- 运行中 2：review-272、review-286。
- review-272 双 PASS（Spec 4/4 独立判定+质量全 info 无阻塞）。
- #272（07.9 重复 ack 只记录一次）集成完成（第 77 张）：governance 两件 cp（settlementoutbox.go ack 幂等扩展+测试新用例）+票面+报告；主仓库 governance 全量 15.8s ok+vet 0。
- 运行中 1：review-286（骨架已落，填证据中）。
- review-286 双 PASS（Spec+Standards：四 AC 工作台运行面全过+五焦点代码级证实；两条范围裁定移交 coordinator——voice summary/titler 等后台工具直连面未改道+readiness 波及 roster，均系有意的已文档化范围裁定，归属 09.2+ 公司 payer/协议门收口票处理，留档不阻塞）。
- #286（09.1 内置工作台调用改走网关）集成完成（第 78 张）：五件 cp（copilot.ts seam 三级权威+agent-resolver 归因+index.ts 接线+7 用例+票面）+报告；集成回归 @b5-245：workbench 7+outbox 6+settle 29=42/42 绿。
- **事故与修复（共享文件覆盖丢增量）**：#250 集成时整文件 cp settings.json 覆盖掉 #263 的 creditsPage locale 键（columnBot/pendingReserved/pendingUnknown+reservationStatus 组），app tsc（b5-245 口径）暴露——flat-key 合并修复（263 版为底+250 独有键回填，实际 250 无独有键=直接 263 版）后 1 错=基线+UI 8/8 绿。**纪律沉淀：locales/json 等多票共享文件集成必须 diff 合并，禁止整文件覆盖（后 cp 者胜）。**
- 主仓库 app tsc 全量口径澄清：根 cwd 跑 app tsc 会连 app/tests+根 tests/support（e2e 迁移债）一起查=~93 错基线；干净口径=b5-245 叠加环境（1 错=用户实验文件）。
- 运行中 0。累计集成 78/151。
- 新一波三票派发（域分离）：#273（07.10 流式最终用量结算，task_1d67b63759f9，ctx_a8d9bccb2519）、#289（09.4 订阅 harness 边界标记，task_a40b7d68fd99，ctx_8ec4d8e81cc5）、#350（21.6 独立测试库事务清理与重建，task_7a5c1a0071e1，ctx_e675b06144de，简报钉死 cleanup-guards 最后门契约+只动自建库）。#276（08.1）排下一波（与 273 同文件域）。DAG 扫描器坑：行内"解锁 #NNN"被宽松正则误标 closed（273/276/286 曾误判已集成）——改行首主语匹配后仍漏抓多数记账行（34 vs 78），就绪判定改为人工把关+扫描辅助。
- 运行中 3：#273、#289、#350。
- #350 首任 succeeded 但零产出（transcript 仅 user 消息未开工）——stop+ready+二任（ctx_9e0d70571745）。
- 运行中 3：#273、#289、#350（二任）。

### 2026-10-18 #273（07.10 流式最终用量结算）
- worker ctx_a8d9bccb2519 succeeded，报告 b5-273.md 落盘。**零生产代码改动形态**：票面四条 AC 语义（仅最终 chunk 定 actualUsage / 断开仍结算 BilledUsage / unknown 记录不投递且 hold 保持 / 流式非流式同一幂等键=AttemptID）已由已集成 07.8 settlementoutbox.go 承载；交付物=测试网 streamsettlement_test.go（5 用例）+ 三组变异验证（A 断开=无收费 / B unknown 按零投递 / C 每 chunk 结算，逐一红）。
- checkpoint 79（files 74 / diff 177967B）；coordinator 复验：哈希 5d49ef08… 一致、settlementoutbox.go 与主仓库集成层 diff 逐字节一致（零生产改动声明属实）、go test -run StreamSettlement -count=1 ok。
- review 已派：task_f833d63b02d4 / ctx_30fe156e30d8（同 worktree 只读，骨架先行简报）。运行中：#289（骨架已落，填充中）、#350 二任（骨架已落，前置契约核验完成）、review-273。
- review-273 双 PASS（ctx_30fe156e30d8，骨架先行约 6 分钟出报告）：四 AC 逐条钉住核实、settlementoutbox.go 与集成层 diff 空确认、独立重做变异 A（测试 2/5 红）确认承重、保守门 first-record-wins 依据核实（AttemptID digest 含 fallbackIndex 不含 attemptNumber）、【零生产改动】形态裁决满足票面（Produces 是行为契约，测试即交付物）。F-1 low（保守门自身无钉住测试→07.11 认领）+F-2/F-3 info，无 critical/high/medium。
- 集成（第 79 张）：streamsettlement_test.go cp 入主仓库 bifrost/plugins/governance/ + 执行报告归档 .omc/reports/b5-273.md；主仓库 governance 全模块 go test ok（27.99s 含新 5 用例）。两 task 已 completed。组 07 至 07.10 闭环。
- 派发下一波三票（同文件域不重叠，并行）：#276（08.1 恢复扫描，task_0f7a9f2d8b7d/ctx_ad1e7db053d7/b5-276，273 集成解锁）、#241（04.8 隐式授权，task_3626b25eaf54/ctx_0a51541f3cbf/b5-241-2）、#268（07.5 重试新准入，task_2646417ebc42/ctx_dfc6274e4b67/b5-268-2）。worktree 基线五步各就绪（50 files）。简报均含骨架先行+专用库纪律+迁移 0147 号提醒。
- 运行中 5：#289、#350 二任、#276、#241、#268。累计集成 79/151。

### 2026-10-18 #268（07.5 重试需新准入）闭环
- worker ctx_dfc6274e4b67 succeeded。**零生产代码改动形态**（07.4/06.3 集成层已承载：每 slot 新 attemptId=SHA-256(provider,model,requestID,nonce,fallbackIndex)+新预留+新承诺；幂等 claim 拒旧标识 dispatch_already_claimed 503 AllowFallbacks=false；retryOfAttemptId 链字段；拒绝终止链）；交付=retryadmission_test.go（5 测试+自包含 numbered fake door）+ mutation 咬合。
- checkpoint 80；coordinator 复验：retryadmission_test.go=d5f995c1…、dispatchcommitment.go=ba753958…与主仓库一致、go test ok。
- review-268 双 PASS（ctx_59d551569156）：四 AC 逐条钉住核实、core fallback 循环/clearCtxForFallback 不清戳与 nonce 逐行核实、独立重做两组 mutation（短路 retryOfAttemptID→测试3/4 红；删 claim 幂等→测试2 红，单变量隔离重做）、测试5 裁决（slot=漏斗级真实尝试，slot 内物理重试有 tracker 逐调用去重计费不免费）PASS。F-1=0 F-2=0 F-3=3（措辞漂移纯文档/typecheck 基线红/建议 07.12 加 slot 内重试累计受预留上限断言）。
- 集成（第 80 张）：retryadmission_test.go cp 入主仓库 + 报告归档；主仓库 governance 全模块 ok（16.05s 含新 5 用例）。两 task completed。
- #350 二任（ctx_9e0d70571745）报告'完成'后卡收尾未退（产出齐：cleanup-rehearsal.ts+测试+checkpoint 快照）——stop+release 代收尾，checkpoint 81（files 75）。coordinator 复验：5594 全新库 openbot_b5_350_c 迁移 ok 后 6/6 pass（93 expect），哈希 bfd78bab…/76d613da… 与报告一致。review-350 已派（task_167dee3732af/ctx_33a7bb1e0b16）。
- #276 首任 ctx_ad1e7db053d7 与 #241 首任 ctx_0a51541f3cbf 均卡在读票面阶段零产出（transcript 证实）——stop+release+ready+二任重派：#276 二任 ctx_58b3534487d1（骨架先行强化）、#241 二任 ctx_2cdf26347d9d（常写盘强化）。#289（ctx_8ec4d8e81cc5）仍在推进（md5 两轮间有变化）。
- 运行中 5：#289、#276 二任、#241 二任、review-350。累计集成 80/151。

### 2026-10-18 #350（21.6 事务清理与重建验证）闭环
- review-350 双 PASS（ctx_33a7bb1e0b16）：全新库三连跑 6/6（93/101/109 expect，计数增长定性为良性残留）、六项代码面声明逐条核实（单事务/子先父后/显式 id/guard 先行/三层对账/import.meta.main 只认 TEST_DATABASE_URL）、并发 FK 40001 非flaky 论证（机制定性+时序确定性+M1 突变反证）、21.5 N1 契约落实（guard→事务 TOCTOU 由事务内存量复核兜底）。突变三组：M1 RR→RC 恰 2 红；M2 关行数差检测 6/0 绿（F-3.1 记录：纵深防御未单独入网，建议 21.7 补）；M3 丢谓词 4 红。F-1=0 F-2=0 F-3=5。
- 集成（第 81 张）：cleanup-rehearsal.ts+测试 cp 入主仓库+报告归档；两 task completed。b5-245 叠加回归：迁移 ok 后 350 六用例 6/6 + 349 守卫 11/11 双绿（此前 b5-245 的 drizzle sql 文件与 journal 漂移已补同步）。给 21.7 契约：executeTransactionalCleanup 行为模板+CleanupRehearsalReport 骨架。
- #351（21.7 授权范围执行与清理报告）派发：双依赖 #350（刚集成）+#295（第 65 张）满足。旧占位 task_ecd5a737ce43 标 completed 解锁，task_c5fa5fefd472 worker-start ctx_09744cbcf7c0，worktree b5-351（基线五步 50 files）。简报含 review-350 移交项（F-3.1 可选加固/F-3.4 勿跑 21.1-21.4 e2e-compat 套件）。
- 运行中 4：#289、#276 二任、#241 二任、#351。累计集成 81/151。

### 2026-10-18 #241（04.8 工作台隐式授权）闭环前半
- 二任 ctx_2cdf26347d9d succeeded，报告'完成（独立重验 11/11 GREEN）'。**零仓库文件改动形态（考古式确认）**：04.8 实现（ensureWorkbenchGrant+workbench-implicit source+0131_access_grant_source 迁移+674 行套件）已由 a18e2711 集成提交进 HEAD；本轮只做全新库独立重验。checkpoint 82（files 50）。
- coordinator 复验：access-grants.ts=089284e2…/套件=4df920ee…与 HEAD blob 逐字节一致（git show 核实）；5594 全新库 openbot_b5_241_c 迁移 ok 后 server/tests 同目录副本（sed 一行 e2e-compat→bun:test）11/11 全绿（75 expect）。副本法三坑记录：import 相对路径层级（须与原套件同目录）、断链 node_modules（不可 cp 树）、sed 引号内路径。
- review-241 已派（task_dca4cd251efd/ctx_4b8ab5348e68，裁决 HEAD 已实现形态）。
- review-241 首任卡死（复现 11/11 后 transcript 停 20+ 分钟、消息戳无响应）——abandon+ready+二任 ctx_cb086590c6ad 接续（采信链简报：三方全新库 11/11+HEAD blob 一致+F1 已修）。二任 ~5 分钟出报告：**双 PASS**——F1 确认 CLOSED 于 HEAD（守卫无 created&& 短路+双路径 granted/reconfirmed，套件 439/487 钉死）；交付形态裁决 PASS（考古式确认=票已收口）。历史第一轮报告已归档 archive/b5-241-round1{,-rereview}.md 防覆盖。
- **#241 集成完成（第 82 张）：零文件集成**（实现早已在 HEAD a18e2711；本轮为全新库重验+双 PASS 复审）。两 task completed。组 04 至 04.8 全链闭环（04.6/04.7 考古项另列）。
- #351（21.7）succeeded，报告完整（16 测试/AC×4/sha256）；checkpoint 83（files 54）。**偏差记录**：worktree 建于 #350 集成前，cleanup-rehearsal.ts 未在其基线（48 文件清单时序所致），worker ask 上报超时后按 21.6 行为模板自实现执行引擎（职责本不同：rehearsal=演练/execution=受控执行；文件名导出不冲突）。主仓库两文件共存，review 需裁定重复可接受性。coordinator 复验进行中。
- #351 coordinator 复验完成：5594 全新库 openbot_b5_351_c 主链 147 迁移 ok+psql 补建 kb 两表后 **16/16（106 expect）**；哈希 e8b18cd7…/077eae52… 一致。review-351 已派（task_f5a61be3a048/ctx_082d9db98c89，含偏差裁定与 kb/主链共用 journal 表名的环境坑说明）。
- **coordinator 事故记录（自查+处置）**：复验时 kb migrate 误用 worktree .env 的 KB_DATABASE_URL 指向 live 55432/kb_mastra——经查该库 drizzle.__drizzle_migrations 仅 1 条且 created_at=10-11（早于本会话），本次为幂等 no-op **零实际变更**；后续纪律：跑 kb migrate 必须显式 KB_DATABASE_URL=<5594 自建库>。另记录：kb 迁移与主链共用 drizzle.__drizzle_migrations 表名+chunks 表撞名，同库共存需主链先行+psql 补建 kb 两表（测试只需 knowledge_bases/knowledges）。

### 2026-10-18 #276（08.1 恢复扫描）闭环前半
- 二任 ctx_58b3534487d1 succeeded，报告 COMPLETED。交付：credit_recovery_items 表（迁移 0147）+recovery-scan.ts（scanOnce 幂等发现+SKIP LOCKED 认领）+maintenance.ts sweep（advisory lock 4_192_008）+index.ts 接线+cleanup-relations 补边（#349 先例）+10 测试 52 断言（真实子进程跨进程）。checkpoint 84（files 56）。
- 领域判断：OpenBot 持久承诺=credit_reservations 行；扫描源=unknown ∪ 过期 reserved（年幼 hold 不命名）。§9 决策（测试 import bun:test 路径 A）coordinator 批准。
- coordinator 复验：5594 全新库 openbot_b5_276_c 迁移 ok（0147）+表在+**10/10（52 expect）**。review-276 已派（task_ccfe7a648d98/ctx_de9f0620466d，含 dispatchcommitment 进程内 store 核实要求）。
- #351 review 运行中（ctx_082d9db98c89）。#289 仍推进。运行中 3：#289、review-276、review-351。累计集成 82/151（#241 零文件集成）。
- fix-276（ctx_84b8c57bf143）快修完成：+年幼 hold 不命名测试（M-F2.1 突变恰 1 红）+FIFO 断言改造为跨批次批次组成断言（**新发现**：claimRecoveryItems 返回序=UPDATE RETURNING 堆序非声明键——M-F2.2a/b 突变双证；08.2+ 消费方若依赖数组序需生产侧显式排序，留档）。11/11（54 expect），生产代码零改动（recovery-scan.ts 复核 12ee5cf3… 未变）。coordinator 复验 11/11 @全新库 openbot_b5_276_c2，哈希 9d76e07e… 一致。
- **#276 集成完成（第 83 张）**：11 文件 cp（0147 迁移三件套/journal 追加 idx147 breakpoints 格式正确/schema 表定义/recovery-scan/maintenance/cleanup-relations 补边/cleanup-guards 文字/index.ts 接线/两测试文件——共享文件 diff 甄别全为纯 276 增量）+报告归档；主仓库 typecheck 本票文件零错误；b5-245 叠加回归 recovery-scan 11/11+guards 11/11+rehearsal 6/6 全绿。三 task completed（实施+review+fix）。review-276 F-3.1 留档：journal idx146 集成层既有 message 代替 breakpoints 风格不一（可不改）。

### 2026-10-18 #351（21.7 授权执行与清理报告）闭环
- review-351 双 PASS（ctx_082d9db98c89；中途撞 Pi 429 速率限制一度停滞，解除后完成）：四 AC 全过+全新库独立复跑 16/16/106+偏差处置合规（21.6 未在其基线=时序事实，按行为模板自实现合规）。突变 M1（回执移出事务）/M3（在途复核中和）16/16 仍过=测试网缺口但静态正确——F 全低危/信息级（F-1 测试网证据级别/F-2 post_verified 行 report.authorization 被 REDDACT/F-3 类型名 CleanupExecutionReport 与 rehearsal 同名不同形/F-4 纵深防御无直接测试/F-5 accountingSmoke+删除拓扑×2/F-6 操作员名）。无有效 critical/high/medium，不返工。
- **集成（第 84 张）**：cleanup-execution.ts/测试/admin 卡片三新文件 cp；audit.ts/billing.tsx 直 cp；guards.ts 合并（主仓库 276 文字底+351 export ESTATE_ID_COLUMNS，Edit 精确缝合）；routes.ts python 合并（desc import+auditEvents import+53 行 GET /cleanup/execution 块插 return routes 前）；locales en/zh admin.json 各并入 billingCleanup 27 键。集成态回归：5594 全新库（主链迁移+psql 补 kb 两表）16/16（106 expect）。**主仓库验证机理记录**：bunfig preload→test-preload→e2e-compat→registerHooks（bun 不支持）=主仓库 server bun test 死的根因链，验证法=临时 sed test-preload 的 mock import 一行（跑完还原），与 worktree 基线第④步同源。
- 留档：F-3 建议 22.1 前把 rehearsal 侧类型改名 CleanupRehearsalReport；F-5 收敛路径见 review §3；F-2 post_verified 剥离 report.authorization 或注释接受。两 task completed。
- 运行中 1：#289（长期推进中）。累计集成 84/151。组 21 全链（21.1-21.7）闭环。
- **DAG 缺口发现**：#248（05.7 撤销后立即拒绝）从未派发（此前"组 05 闭环"判读漏项——语义部分存在于 #244/#247 的 revoked uniform refusal 但四 AC 未逐条验证）；其下游 #251（05.10 用户 Key 状态 UI+全版本撤销）随之未做，#248/#251 未做导致 22.1 的依赖 #251 未满足。已派 #248（task_5bbcd8fb778c/ctx_25a7dc1f8eff/b5-248，勘察+补钉形态简报）。
- #277（08.2 持久化结果未 ack 恢复重放）派发（task_c78362a04ea7/ctx_ac67fe70c8b3/b5-277，08.1 集成解锁；含 claimRecoveryItems 堆序事实与 0148 迁移号提醒）。08.4 与 08.2 同域（recovery 表 state 扩展）串行等 08.2。
- 基线清单重新生成（58 文件，含 276/351 新集成层）并同步两 worktree+bifrost governance rsync。运行中 3：#289（长期）、#248、#277。

### 2026-10-18 #289（09.4 订阅 harness 边界标记）闭环前半
- ctx_8ec4d8e81cc5 succeeded（长期任务收尾），报告完整（13 文件：类型标记+billingMethodForModel+订阅路径绕过 meter/gate+三审计事件+admin API/UI/locales；4+44 关联 48/48 e2e）。checkpoint 85（files 82）。
- coordinator 复验：server 4/4（副本法 16 expect）+app 2/2（e2e 单文件干净态）+三关键哈希一致。**e2e 卡死旧坑复发**（并发+残留 .e2e 0% CPU，pkill+rm -rf .e2e 处理后正常）。**纪律留档**：worker 曾用 git stash 做 HEAD 基线对照（已 pop 复原，栈无新增——栈中 task4/task5 条目为用户历史遗留勿动）。
- review-289 已派。运行中 4：#248、#277、review-289。累计集成 84/151。

### 2026-10-18 #289（09.4 订阅 harness 边界标记）闭环
- review-289 双 PASS（mutation A/B 承重：订阅路径也走 meter/credit 拒绝后回退订阅两方向都被钉死；stash 对照违规核实为 2026-10-15 用户历史栈条目非本票新增）。二任 review 因原任在收尾时完成而友好终止（succeeded 零工作）。
- **集成（第 85 张）**：plan-model/enterprise.tsx/queries.ts+两测试+组件+报告直 cp；audit.ts 合并（289 三词条 model.billing_path_marked/subscription_path_used/credit_refused 插入 21.7 词条前，缩进坑记录：锚文本须匹配实际 2 空格 /**）；controls.ts/routes.ts Edit 缝合（builtInModelBilling 字段+传参，曾误插 docstring 内已修复）；copilot.ts 重定为直接 cp（主仓库无独有实义增量）；index.ts 长锚五块合并（import 三名+builtInModelBilling 传参+setModelBillingAudit 映射块+复位行+boot posture 审计块，两次短锚错位教训：**短行锚（如 '  });'）必错位，须 3 行以上唯一长锚**）。集成态 typecheck 干净+4/4（16 expect）@副本法。
- 运行中 2：#248 二任（ctx_95e96d932193）、#277（ctx_ac67fe70c8b3）。累计集成 85/151。组 09 至 09.4 闭环。

### 2026-10-18 #248/#277 闭环前半（双双复验通过）
- #248（05.7）二任 ctx_95e96d932193 succeeded。勘察结论：AC1/AC3 缺失（revokeForUser 原只翻 grant 行不动 gateway_virtual_keys）、AC2/AC4 既有——按形态二交付：revokeForUser 事务内同步失效全部 active key 版本+key-revocation.ts 容错网关禁用器+registry 接线+6 测试。无迁移。checkpoint 86。coordinator 复验 6/6（33 expect）@openbot_b5_248_c（worktree preload 曾指向不存在的 bun-test-compat，sed 修复——第④步 sed 模式需覆盖两种 compat 形态）。**纪律违规留档**：worker 复核会话曾在 55432 live 容器建 openbot_b5_248 测试库（DATABASE_URL 派生坑）——未删待终局统一清理；55432 内共发现 25 个历史 b5 测试库（长期现象）。
- #277（08.2）ctx_ac67fe70c8b3 succeeded（中途一次 429 静默，激活后恢复）。交付：recovery-replay.ts 四分支重放+迁移 0148（state 放宽 resolved+claim 一致性约束重写+手写 snapshot）+7 测试 70 断言（GREEN 中修两真实缺陷：批次计数 snake_case 索引 NaN、pending 泄漏跨批次）。checkpoint 87。coordinator 复验 7/7（70 expect）@openbot_b5_277_c（0148 应用+4 约束在位）。
- 双 review 已派：review-248（task_24d1efb98dcb/ctx_67a26fa568bc）、review-277（task_4fa48eaa87f6/ctx_5b97761c12a2）。运行中 2。累计集成 85/151。

### 2026-10-18 #277（08.2 恢复重放）闭环
- review-277 双 PASS（六职责独立验证+五组单变量突变全承重；0148 迁移纯放宽向后兼容实核；F1 无保留意见；O1 shared-queue 甄别/O2 sweeper 竞态=跨票设计属性）。
- **集成（第 86 张）**：7 文件 cp（recovery-replay.ts/recovery-scan.ts state 扩宽/schema/0148 三件套/测试）+support/recovery-replay-worker.ts（首漏 cp 致跨进程用例挂，补）+报告归档。集成态三套件回归 11/11+7/7+16/16 全绿。
- **主仓库大事件记录**：用户已推 5+ 新提交（b848d1cf→d137a323，bun-test-compat 体系/preload 归属/CI 排除），主 HEAD 由 3e8a6072→d137a323；用户 399b7b61 收编了 276 集成的 recovery-scan 测试（改写为 bun-test-compat import 形态）。**worker 越界两例回退**：tests/support/bun-test-compat.ts 被改回 e2e-compat re-export（git checkout 恢复 HEAD 版后三套件恢复全绿）；server/scripts/test-preload.ts 工作区现为 bun:test 直连（验证态）。**后续 worktree 基线策略更新：reset 目标改用新 HEAD+最新工作区层清单**。
- 两 task completed。组 08 至 08.2 闭环。
- review-248（ctx_67a26fa568bc）持续撞 Pi 429 速率限制（25+ 分钟，账户级窗口），处于等待状态。运行中 1。累计集成 86/151。
